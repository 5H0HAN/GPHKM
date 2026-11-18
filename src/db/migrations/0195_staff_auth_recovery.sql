CREATE OR REPLACE FUNCTION public.gphkm_activate_staff(target_user text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  target_role text;
  target_active boolean;
  email_ok boolean;
BEGIN
  IF actor_id IS NULL OR target_user IS NULL OR actor_id = target_user THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('staff-active-admins', 0));
  IF NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT s.role, s.active, u.email_verified
    INTO target_role, target_active, email_ok
    FROM public.staff_account s
    JOIN public.auth_user u ON u.id = s.user_id
   WHERE s.user_id = target_user
     FOR UPDATE OF s;

  -- Staff invitations grant Admin or Finance only. Super Admin authority is
  -- reserved for controlled bootstrap or promotion from an active Admin.
  IF NOT FOUND OR target_role = 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '23514';
  END IF;
  IF target_active THEN RETURN; END IF;
  IF NOT coalesce(email_ok, false) THEN
    RAISE EXCEPTION 'verified staff email required' USING ERRCODE = '23514';
  END IF;
  UPDATE public.staff_account SET active = true WHERE user_id = target_user AND NOT active;
  DELETE FROM public.auth_session WHERE user_id = target_user;
  INSERT INTO public.audit_event(id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (gen_random_uuid()::text, actor_id, 'staff.activated', 'staff_account', target_user,
      jsonb_build_object('result', target_role));
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_activate_staff(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_activate_staff(text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_promote_super_admin(target_user text, target_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  target_role text;
  target_active boolean;
  email_ok boolean;
BEGIN
  IF actor_id IS NULL OR target_user IS NULL OR actor_id = target_user
     OR target_reason IS NULL OR target_reason !~ '^[A-Z0-9_]{2,64}$' THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('staff-active-admins', 0));
  IF NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT s.role, s.active, u.email_verified
    INTO target_role, target_active, email_ok
    FROM public.staff_account s
    JOIN public.auth_user u ON u.id = s.user_id
   WHERE s.user_id = target_user
     FOR UPDATE OF s;

  IF NOT FOUND OR target_role <> 'ADMIN' OR NOT target_active THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '23514';
  END IF;
  IF NOT coalesce(email_ok, false) THEN
    RAISE EXCEPTION 'verified staff email required' USING ERRCODE = '23514';
  END IF;

  UPDATE public.staff_account SET role = 'SUPER_ADMIN' WHERE user_id = target_user;
  DELETE FROM public.auth_session WHERE user_id = target_user;
  INSERT INTO public.audit_event(id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, actor_id, 'staff.super_admin_promoted', 'staff_account', target_user,
      target_reason, jsonb_build_object('fromState', 'ADMIN', 'toState', 'SUPER_ADMIN'));
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_promote_super_admin(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_promote_super_admin(text, text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_break_glass_recover_super_admin(
  target_user text,
  target_password_hash text,
  target_reason text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  target_role text;
  capable_peer boolean;
BEGIN
  IF target_user IS NULL OR target_password_hash IS NULL
     OR target_password_hash !~ '^[0-9a-f]{16,64}:[0-9a-f]{64,255}[0-9a-f]?$'
     OR target_reason IS NULL OR target_reason !~ '^[A-Z0-9_]{2,64}$' THEN
    RAISE EXCEPTION 'recovery input rejected' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('staff-active-admins', 0));
  SELECT role INTO target_role
    FROM public.staff_account
   WHERE user_id = target_user
     FOR UPDATE;
  IF NOT FOUND OR target_role <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'super admin recovery unavailable' USING ERRCODE = '23514';
  END IF;

  -- Refuse while another active, email-verified Super Admin has a password
  -- credential and can keep staff access available. Historical TOTP rows are
  -- dormant and do not prove that a password-only staff account can sign in.
  SELECT EXISTS (
    SELECT 1
      FROM public.staff_account s
      JOIN public.auth_user u ON u.id = s.user_id
     WHERE s.role = 'SUPER_ADMIN'
       AND s.active
       AND s.user_id <> target_user
       AND u.email_verified
       AND EXISTS (SELECT 1 FROM public.auth_account a
                    WHERE a.user_id = u.id
                      AND a.provider_id = 'credential'
                      AND a.password IS NOT NULL)
  ) INTO capable_peer;
  IF capable_peer THEN
    RAISE EXCEPTION 'another active super admin can perform web recovery' USING ERRCODE = '23514';
  END IF;

  UPDATE public.auth_account
     SET password = target_password_hash, updated_at = now()
   WHERE user_id = target_user AND provider_id = 'credential';
  IF NOT FOUND THEN
    INSERT INTO public.auth_account(id, account_id, provider_id, user_id, password, created_at, updated_at)
      VALUES (gen_random_uuid()::text, target_user, 'credential', target_user,
              target_password_hash, now(), now());
  END IF;

  -- Better Auth verification values equal the user ID for pending resets
  -- and sign-in challenges. Recovery must invalidate those as well.
  DELETE FROM public.auth_verification WHERE value = target_user;
  DELETE FROM public.auth_two_factor WHERE user_id = target_user;
  DELETE FROM public.staff_mfa_session WHERE user_id = target_user;
  DELETE FROM public.auth_session WHERE user_id = target_user;
  UPDATE public.auth_user SET two_factor_enabled = false WHERE id = target_user;
  UPDATE public.staff_account SET active = true WHERE user_id = target_user;

  INSERT INTO public.audit_event(id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, NULL, 'staff.break_glass_recovered', 'staff_account', target_user,
      target_reason, jsonb_build_object('result', 'password_and_totp_reset'));
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_break_glass_recover_super_admin(text, text, text) FROM PUBLIC;
-- No grant to gphkm_runtime, gphkm_worker, gphkm_webhook, or gphkm_mfa_proof.

CREATE FUNCTION public.gphkm_staff_invitation_email_available(target_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(
    target_email IS NOT NULL
    AND target_email <> ''
    AND target_email = lower(btrim(target_email))
    AND NOT EXISTS (
      SELECT 1 FROM public.auth_user u
       WHERE lower(u.email) = target_email
         AND (
           EXISTS (SELECT 1 FROM public.staff_account s WHERE s.user_id = u.id)
           OR EXISTS (SELECT 1 FROM public.organization_member m WHERE m.user_id = u.id)
         )
    ),
    false
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_staff_invitation_email_available(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_staff_invitation_email_available(text) TO gphkm_runtime;

-- Restore the read-only lookup removed in 0194. This identifies pending
-- invitees for existing sessions and reset delivery; signup still needs the
-- invitation secret checked by gphkm_staff_invitation_matches.
CREATE FUNCTION public.gphkm_staff_email_has_pending_invitation(target_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_staff_invitation_email_available(target_email) AND EXISTS (
    SELECT 1 FROM public.staff_invitation i
     WHERE lower(i.email) = target_email
       AND i.status = 'PENDING'
       AND i.expires_at > now()
       AND i.accepted_by_user_id IS NULL
       AND i.accepted_at IS NULL
       AND i.revoked_at IS NULL
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_staff_email_has_pending_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_staff_email_has_pending_invitation(text) TO gphkm_runtime;

-- Password recovery and first password setup can occur before an account has
-- organization membership or active staff status. Permit only their own event.
CREATE POLICY audit_event_auth_password_self_insert ON public.audit_event
  FOR INSERT TO gphkm_runtime WITH CHECK (
    organization_id IS NULL
    AND actor_user_id = nullif(current_setting('app.user_id', true), '')
    AND target_type = 'auth_user'
    AND target_id = actor_user_id
    AND action IN ('auth.password_reset_completed', 'customer.password_added')
  );

-- The invitee can read the updated row for UPDATE RETURNING and record their
-- acceptance. Both policies require the specific invitation digest and actor.
CREATE POLICY staff_invitation_accepted_self_read ON public.staff_invitation
  FOR SELECT TO gphkm_runtime USING (
    token_hash = nullif(current_setting('app.staff_invitation_token_hash', true), '')
    AND status = 'ACCEPTED'
    AND accepted_by_user_id = nullif(current_setting('app.user_id', true), '')
  );

CREATE POLICY audit_event_staff_invitation_accepted_insert ON public.audit_event
  FOR INSERT TO gphkm_runtime WITH CHECK (
    organization_id IS NULL
    AND actor_user_id = nullif(current_setting('app.user_id', true), '')
    AND action = 'staff.invitation_accepted'
    AND target_type = 'staff_invitation'
    AND EXISTS (
      SELECT 1 FROM public.staff_invitation i
       WHERE i.id = target_id
         AND i.token_hash = nullif(current_setting('app.staff_invitation_token_hash', true), '')
         AND i.status = 'ACCEPTED'
         AND i.accepted_by_user_id = actor_user_id
    )
  );
