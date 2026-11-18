-- Keep sensitive staff transitions aligned with the approved password-only
-- staff login. This also repairs databases that already applied the earlier
-- staff auth migrations before their final policy was settled.
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

CREATE OR REPLACE FUNCTION public.gphkm_promote_super_admin(target_user text, target_reason text) RETURNS void
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

CREATE OR REPLACE FUNCTION public.gphkm_break_glass_recover_super_admin(
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

  -- Only a password-capable peer keeps current staff access available.
  -- Dormant legacy TOTP records do not satisfy password-only staff login.
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

  DELETE FROM public.auth_verification WHERE value = target_user;
  DELETE FROM public.auth_two_factor WHERE user_id = target_user;
  DELETE FROM public.staff_mfa_session WHERE user_id = target_user;
  DELETE FROM public.auth_session WHERE user_id = target_user;
  UPDATE public.auth_user SET two_factor_enabled = false WHERE id = target_user;
  UPDATE public.staff_account SET active = true WHERE user_id = target_user;

  INSERT INTO public.audit_event(id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, NULL, 'staff.break_glass_recovered', 'staff_account', target_user,
      target_reason, jsonb_build_object('result', 'password_and_legacy_factor_reset'));
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_break_glass_recover_super_admin(text, text, text) FROM PUBLIC;
-- No grant to gphkm_runtime, gphkm_worker, gphkm_webhook, or gphkm_mfa_proof.
