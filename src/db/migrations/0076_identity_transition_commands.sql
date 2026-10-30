-- Remove direct runtime updates from identity authority tables. Sensitive
-- membership and staff transitions are now narrow, audited DB commands.
REVOKE UPDATE ON public.organization_member, public.staff_account FROM gphkm_runtime;
DROP POLICY IF EXISTS organization_member_update_owner ON public.organization_member;
DROP POLICY IF EXISTS organization_member_reactivate_by_invitation ON public.organization_member;
DROP POLICY IF EXISTS staff_account_super_admin_update ON public.staff_account;

-- Organization member creation is limited to the first Owner. Invitation
-- acceptance creates/reactivates a Member through the command below.
DROP POLICY IF EXISTS organization_member_create_owner_or_invitee ON public.organization_member;
CREATE POLICY organization_member_create_first_owner ON public.organization_member FOR INSERT TO gphkm_runtime
  WITH CHECK (
    user_id = nullif(current_setting('app.user_id', true), '')
    AND role = 'OWNER' AND active
    AND public.gphkm_org_created_by(organization_id, nullif(current_setting('app.user_id', true), ''))
  );

CREATE FUNCTION public.gphkm_promote_organization_member(target_org text, target_user text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); member_role text; member_active boolean;
BEGIN
  IF target_org IS NULL OR target_user IS NULL
     OR target_org IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')
     OR NOT public.gphkm_is_active_org_owner(target_org, actor_id) THEN
    RAISE EXCEPTION 'member unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organization WHERE id = target_org AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization unavailable' USING ERRCODE = '23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-owners:' || target_org, 0));
  SELECT role, active INTO member_role, member_active FROM public.organization_member
    WHERE organization_id = target_org AND user_id = target_user FOR UPDATE;
  IF NOT FOUND OR member_role <> 'MEMBER' OR NOT member_active THEN
    RAISE EXCEPTION 'member unavailable' USING ERRCODE = '23514';
  END IF;
  UPDATE public.organization_member SET role = 'OWNER'
    WHERE organization_id = target_org AND user_id = target_user AND role = 'MEMBER' AND active;
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (gen_random_uuid()::text, target_org, actor_id, 'organization.member_role_changed',
      'organization_member', target_user, jsonb_build_object('fromState', 'MEMBER', 'toState', 'OWNER'));
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_promote_organization_member(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_promote_organization_member(text, text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_remove_organization_member(target_org text, target_user text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); member_role text; member_active boolean; other_owners integer;
BEGIN
  IF target_org IS NULL OR target_user IS NULL
     OR target_org IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')
     OR NOT public.gphkm_is_active_org_owner(target_org, actor_id) THEN
    RAISE EXCEPTION 'member unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organization WHERE id = target_org AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization unavailable' USING ERRCODE = '23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-owners:' || target_org, 0));
  SELECT role, active INTO member_role, member_active FROM public.organization_member
    WHERE organization_id = target_org AND user_id = target_user FOR UPDATE;
  IF NOT FOUND OR NOT member_active THEN RAISE EXCEPTION 'member unavailable' USING ERRCODE = '23514'; END IF;
  IF member_role = 'OWNER' THEN
    SELECT count(*) INTO other_owners FROM public.organization_member
      WHERE organization_id = target_org AND role = 'OWNER' AND active AND user_id <> target_user;
    IF other_owners = 0 THEN RAISE EXCEPTION 'last owner cannot be removed' USING ERRCODE = '23514'; END IF;
  END IF;
  UPDATE public.organization_member SET active = false
    WHERE organization_id = target_org AND user_id = target_user AND active;
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (gen_random_uuid()::text, target_org, actor_id, 'organization.member_removed',
      'organization_member', target_user, jsonb_build_object('fromState', member_role, 'toState', 'INACTIVE'));
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_remove_organization_member(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_remove_organization_member(text, text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_accept_organization_invitation(target_invitation text, membership_id text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); invite_token_hash text := nullif(current_setting('app.invitation_token_hash', true), '');
  org_id text; invite_email text; invite_status text; invite_expires timestamptz; user_email text; verified boolean; existing_role text; existing_active boolean;
BEGIN
  IF actor_id IS NULL OR invite_token_hash IS NULL OR target_invitation IS NULL OR membership_id !~ '^[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT i.organization_id INTO org_id FROM public.organization_invitation i
    WHERE i.id = target_invitation AND i.token_hash = invite_token_hash;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.organization WHERE id = org_id AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization unavailable' USING ERRCODE = '42501'; END IF;
  SELECT i.organization_id, i.email, i.status::text, i.expires_at, u.email, u.email_verified
    INTO org_id, invite_email, invite_status, invite_expires, user_email, verified
    FROM public.organization_invitation i JOIN public.auth_user u ON u.id = actor_id
    JOIN public.organization o ON o.id = i.organization_id
    WHERE i.id = target_invitation AND i.token_hash = invite_token_hash AND o.closed_at IS NULL
    FOR UPDATE OF i;
  IF NOT FOUND OR invite_status <> 'PENDING' OR invite_expires <= now()
     OR lower(invite_email) <> lower(user_email) OR NOT verified THEN
    RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT role, active INTO existing_role, existing_active FROM public.organization_member
    WHERE organization_id = org_id AND user_id = actor_id FOR UPDATE;
  IF FOUND THEN
    IF existing_active THEN RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = '23514'; END IF;
    UPDATE public.organization_member SET role = 'MEMBER', active = true
      WHERE organization_id = org_id AND user_id = actor_id AND NOT active;
  ELSE
    INSERT INTO public.organization_member(id, organization_id, user_id, role, active)
      VALUES (membership_id, org_id, actor_id, 'MEMBER', true);
  END IF;
  UPDATE public.organization_invitation SET status = 'ACCEPTED', accepted_by_user_id = actor_id, accepted_at = clock_timestamp()
    WHERE id = target_invitation AND status = 'PENDING' AND expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = '23514'; END IF;
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (gen_random_uuid()::text, org_id, actor_id, 'organization.invitation_accepted',
      'organization_invitation', target_invitation, jsonb_build_object('result', 'accepted'));
  RETURN org_id;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_accept_organization_invitation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_accept_organization_invitation(text, text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_activate_staff(target_user text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); target_role text; target_active boolean; mfa_valid boolean;
BEGIN
  IF actor_id IS NULL OR target_user IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN') OR actor_id = target_user THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT role, active INTO target_role, target_active FROM public.staff_account WHERE user_id = target_user FOR UPDATE;
  IF NOT FOUND OR target_role = 'SUPER_ADMIN' THEN RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '23514'; END IF;
  SELECT u.two_factor_enabled AND EXISTS (SELECT 1 FROM public.auth_two_factor f WHERE f.user_id = u.id AND f.verified)
    INTO mfa_valid FROM public.auth_user u WHERE u.id = target_user;
  IF NOT coalesce(mfa_valid, false) THEN RAISE EXCEPTION 'verified staff MFA required' USING ERRCODE = '23514'; END IF;
  IF target_active THEN RETURN; END IF;
  UPDATE public.staff_account SET active = true WHERE user_id = target_user AND NOT active;
  DELETE FROM public.auth_session WHERE user_id = target_user;
  INSERT INTO public.audit_event(id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (gen_random_uuid()::text, actor_id, 'staff.activated', 'staff_account', target_user,
      jsonb_build_object('result', target_role));
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_activate_staff(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_activate_staff(text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_change_staff_role(target_user text, target_role text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); old_role text;
BEGIN
  IF actor_id IS NULL OR target_user IS NULL OR target_role NOT IN ('ADMIN', 'FINANCE')
     OR NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN') OR actor_id = target_user THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT role INTO old_role FROM public.staff_account WHERE user_id = target_user FOR UPDATE;
  IF NOT FOUND OR old_role = 'SUPER_ADMIN' THEN RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '23514'; END IF;
  IF old_role = target_role THEN RETURN false; END IF;
  UPDATE public.staff_account SET role = target_role WHERE user_id = target_user;
  DELETE FROM public.auth_session WHERE user_id = target_user;
  INSERT INTO public.audit_event(id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (gen_random_uuid()::text, actor_id, 'staff.role_changed', 'staff_account', target_user,
      jsonb_build_object('fromState', old_role, 'toState', target_role));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_change_staff_role(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_change_staff_role(text, text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_deactivate_staff(target_user text, target_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); target_role text; target_active boolean; active_admins integer;
BEGIN
  IF actor_id IS NULL OR target_user IS NULL OR actor_id = target_user OR target_reason !~ '^[A-Z0-9_]{2,64}$'
     OR NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('staff-active-admins', 0));
  SELECT role, active INTO target_role, target_active FROM public.staff_account WHERE user_id = target_user FOR UPDATE;
  IF NOT FOUND OR NOT target_active THEN RAISE EXCEPTION 'active staff account unavailable' USING ERRCODE = '23514'; END IF;
  IF target_role = 'SUPER_ADMIN' THEN
    SELECT count(*) INTO active_admins FROM public.staff_account WHERE role = 'SUPER_ADMIN' AND active;
    IF active_admins <= 1 THEN RAISE EXCEPTION 'cannot deactivate the last active Super Admin' USING ERRCODE = '23514'; END IF;
  END IF;
  UPDATE public.staff_account SET active = false WHERE user_id = target_user AND active;
  DELETE FROM public.auth_session WHERE user_id = target_user;
  INSERT INTO public.audit_event(id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, actor_id, 'staff.deactivated', 'staff_account', target_user, target_reason,
      jsonb_build_object('result', 'deactivated'));
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_deactivate_staff(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_deactivate_staff(text, text) TO gphkm_runtime;

-- New staff identities may be created by OAuth only when a matching invite is
-- pending. Existing users may still sign in on the staff host and are denied
-- protected access unless a staff_account exists and is active/MFA-verified.
CREATE FUNCTION public.gphkm_staff_email_has_pending_invitation(target_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(target_email, '') <> '' AND EXISTS (
    SELECT 1 FROM public.staff_invitation i
    WHERE lower(i.email) = lower(target_email) AND i.status = 'PENDING' AND i.expires_at > now()
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_staff_email_has_pending_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_staff_email_has_pending_invitation(text) TO gphkm_runtime;
