-- Serialize customer commands with account suspension and reject stale sessions.
-- Predicates remain non-locking for use by RLS; commands call the explicit guard.
CREATE FUNCTION public.gphkm_customer_is_active(target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT target_user IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.auth_user u WHERE u.id = target_user AND u.email_verified)
    AND NOT EXISTS (SELECT 1 FROM public.staff_account s WHERE s.user_id = target_user)
    AND NOT EXISTS (SELECT 1 FROM public.customer_account_control c WHERE c.user_id = target_user AND c.state = 'SUSPENDED')
$$;
REVOKE ALL ON FUNCTION public.gphkm_customer_is_active(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_customer_is_active(text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_assert_active_customer(exclusive_lock boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); verified boolean;
BEGIN
  IF actor_id IS NULL THEN RAISE EXCEPTION 'customer unavailable' USING ERRCODE = '42501'; END IF;
  -- Take this before organization/advisory locks. Onboarding takes UPDATE because
  -- the exclusive identity trigger also locks auth_user FOR UPDATE.
  IF exclusive_lock THEN
    PERFORM 1 FROM public.auth_user WHERE id = actor_id FOR UPDATE;
  ELSE
    PERFORM 1 FROM public.auth_user WHERE id = actor_id FOR SHARE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer unavailable' USING ERRCODE = '42501'; END IF;
  SELECT email_verified INTO verified FROM public.auth_user WHERE id = actor_id;
  IF NOT coalesce(verified, false)
     OR EXISTS (SELECT 1 FROM public.staff_account WHERE user_id = actor_id)
     OR EXISTS (SELECT 1 FROM public.customer_account_control WHERE user_id = actor_id AND state = 'SUSPENDED') THEN
    RAISE EXCEPTION 'customer unavailable' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_assert_active_customer(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_assert_active_customer(boolean) TO gphkm_runtime;

CREATE OR REPLACE FUNCTION public.gphkm_is_active_org_member(target_org text, target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_customer_is_active(target_user) AND EXISTS (
    SELECT 1 FROM public.organization_member m
    WHERE m.organization_id = target_org AND m.user_id = target_user AND m.active)
$$;
CREATE OR REPLACE FUNCTION public.gphkm_is_active_org_owner(target_org text, target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_customer_is_active(target_user) AND EXISTS (
    SELECT 1 FROM public.organization_member m
    WHERE m.organization_id = target_org AND m.user_id = target_user AND m.active AND m.role = 'OWNER')
$$;

DROP POLICY organization_create_self ON public.organization;
CREATE POLICY organization_create_self ON public.organization FOR INSERT TO gphkm_runtime
  WITH CHECK (created_by = nullif(current_setting('app.user_id', true), '')
    AND public.gphkm_customer_is_active(nullif(current_setting('app.user_id', true), '')));

DROP POLICY organization_member_create_first_owner ON public.organization_member;
CREATE POLICY organization_member_create_first_owner ON public.organization_member FOR INSERT TO gphkm_runtime
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '') AND role = 'OWNER' AND active
    AND public.gphkm_customer_is_active(nullif(current_setting('app.user_id', true), ''))
    AND public.gphkm_org_created_by(organization_id, nullif(current_setting('app.user_id', true), '')));

DROP POLICY organization_member_read_self_or_tenant ON public.organization_member;
CREATE POLICY organization_member_read_self_or_tenant ON public.organization_member FOR SELECT TO gphkm_runtime
  USING (public.gphkm_customer_is_active(nullif(current_setting('app.user_id', true), ''))
    AND (user_id = nullif(current_setting('app.user_id', true), '')
      OR (organization_id = nullif(current_setting('app.organization_id', true), '')
        AND public.gphkm_is_active_org_member(organization_member.organization_id,
          nullif(current_setting('app.user_id', true), '')))));

CREATE OR REPLACE FUNCTION public.gphkm_accept_organization_invitation(target_invitation text, membership_id text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); invite_token_hash text := nullif(current_setting('app.invitation_token_hash', true), '');
  org_id text; invite_email text; invite_status text; invite_expires timestamptz; user_email text; verified boolean; existing_role text; existing_active boolean;
BEGIN
  IF actor_id IS NULL OR invite_token_hash IS NULL OR target_invitation IS NULL OR membership_id !~ '^[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = '42501';
  END IF;
  -- Exclusive lock is acquired before organization and invitation locks; it also
  -- matches the identity-domain trigger used by first membership creation.
  PERFORM 1 FROM public.auth_user WHERE id = actor_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = '42501'; END IF;
  SELECT email_verified INTO verified FROM public.auth_user WHERE id = actor_id;
  IF NOT coalesce(verified, false)
     OR EXISTS (SELECT 1 FROM public.staff_account WHERE user_id = actor_id)
     OR EXISTS (SELECT 1 FROM public.customer_account_control WHERE user_id = actor_id AND state = 'SUSPENDED') THEN
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

-- Serialize session persistence with suspension. Signup may still create an
-- unverified session; only suspended customer identities are rejected here.
CREATE FUNCTION public.gphkm_reject_suspended_customer_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM 1 FROM public.auth_user WHERE id = NEW.user_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session unavailable' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staff_account WHERE user_id = NEW.user_id)
     AND EXISTS (SELECT 1 FROM public.customer_account_control WHERE user_id = NEW.user_id AND state = 'SUSPENDED') THEN
    RAISE EXCEPTION 'session unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_suspended_customer_session() FROM PUBLIC;
CREATE TRIGGER auth_session_reject_suspended_customer
  BEFORE INSERT ON public.auth_session FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_suspended_customer_session();
