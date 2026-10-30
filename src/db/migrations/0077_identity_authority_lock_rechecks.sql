-- Serialize authority transitions and recheck the acting role after the lock.
-- This closes the race where a command passes an app/DB permission check,
-- waits for another transition, then acts after its authority was revoked.

CREATE OR REPLACE FUNCTION public.gphkm_promote_organization_member(target_org text, target_user text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); member_role text; member_active boolean;
BEGIN
  IF target_org IS NULL OR target_user IS NULL
     OR target_org IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '') THEN
    RAISE EXCEPTION 'member unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organization WHERE id = target_org AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT public.gphkm_is_active_org_owner(target_org, actor_id) THEN
    RAISE EXCEPTION 'organization unavailable' USING ERRCODE = '42501';
  END IF;
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

CREATE OR REPLACE FUNCTION public.gphkm_remove_organization_member(target_org text, target_user text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); member_role text; member_active boolean; other_owners integer;
BEGIN
  IF target_org IS NULL OR target_user IS NULL
     OR target_org IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '') THEN
    RAISE EXCEPTION 'member unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organization WHERE id = target_org AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT public.gphkm_is_active_org_owner(target_org, actor_id) THEN
    RAISE EXCEPTION 'organization unavailable' USING ERRCODE = '42501';
  END IF;
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

CREATE OR REPLACE FUNCTION public.gphkm_activate_staff(target_user text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); target_role text; target_active boolean; mfa_valid boolean;
BEGIN
  IF actor_id IS NULL OR target_user IS NULL OR actor_id = target_user THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('staff-active-admins', 0));
  IF NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN') THEN
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

CREATE OR REPLACE FUNCTION public.gphkm_change_staff_role(target_user text, target_role text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); old_role text;
BEGIN
  IF actor_id IS NULL OR target_user IS NULL OR target_role NOT IN ('ADMIN', 'FINANCE') OR actor_id = target_user THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('staff-active-admins', 0));
  IF NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN') THEN
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

CREATE OR REPLACE FUNCTION public.gphkm_deactivate_staff(target_user text, target_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); target_role text; target_active boolean; active_admins integer;
BEGIN
  IF actor_id IS NULL OR target_user IS NULL OR actor_id = target_user OR target_reason !~ '^[A-Z0-9_]{2,64}$' THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('staff-active-admins', 0));
  IF NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '42501';
  END IF;
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
