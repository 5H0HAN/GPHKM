-- Pending or deactivated staff may need to authenticate and prove MFA so a
-- Super Admin can activate/reactivate them. This proof grants no staff access:
-- application authorization still requires an active staff_account.
CREATE OR REPLACE FUNCTION public.gphkm_record_staff_mfa_proof(
  target_user_id text, target_session_id text, target_method text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE written integer;
BEGIN
  IF session_user <> 'gphkm_mfa_proof'
     OR target_user_id IS NULL OR target_session_id IS NULL
     OR target_method NOT IN ('TOTP','BACKUP_CODE','OTP')
     OR NOT EXISTS (
       SELECT 1 FROM public.staff_account s
       JOIN public.auth_user u ON u.id = s.user_id
       JOIN public.auth_session a ON a.user_id = u.id
       WHERE s.user_id = target_user_id
         AND u.two_factor_enabled
         AND a.id = target_session_id AND a.expires_at > clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'staff MFA proof unavailable' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.staff_mfa_session(session_id, user_id, method, verified_at)
  VALUES (target_session_id, target_user_id, target_method::public.staff_mfa_method, clock_timestamp())
  ON CONFLICT (session_id) DO UPDATE
    SET method = EXCLUDED.method, verified_at = EXCLUDED.verified_at
    WHERE public.staff_mfa_session.user_id = EXCLUDED.user_id;
  GET DIAGNOSTICS written = ROW_COUNT;
  IF written <> 1 THEN RAISE EXCEPTION 'staff MFA proof unavailable' USING ERRCODE = '42501'; END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_record_staff_mfa_proof(text,text,text) FROM PUBLIC, gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_record_staff_mfa_proof(text,text,text) TO gphkm_mfa_proof;
