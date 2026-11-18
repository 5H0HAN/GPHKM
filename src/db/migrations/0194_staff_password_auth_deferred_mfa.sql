-- Staff password setup must match a pending invitation for the same
-- normalized email and a SHA-256 token digest. The runtime receives only a
-- boolean result; the invitation row remains behind SECURITY DEFINER.
CREATE FUNCTION public.gphkm_staff_invitation_matches(target_email text, target_token_hash text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(
    target_email IS NOT NULL
    AND target_email <> ''
    AND target_email = lower(btrim(target_email))
    AND target_token_hash ~ '^[0-9a-f]{64}$'
    AND EXISTS (
      SELECT 1
        FROM public.staff_invitation invitation
       WHERE lower(btrim(invitation.email)) = target_email
         AND invitation.token_hash = target_token_hash
         AND invitation.status = 'PENDING'
         AND invitation.expires_at > now()
         AND invitation.accepted_by_user_id IS NULL
         AND invitation.accepted_at IS NULL
         AND invitation.revoked_at IS NULL
    ),
    false
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_staff_invitation_matches(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_staff_invitation_matches(text, text) TO gphkm_runtime;
DROP FUNCTION public.gphkm_staff_email_has_pending_invitation(text);

-- Staff now authenticate with invite-bound, verified email/password. Preserve
-- the serialized Super Admin activation command, session revocation, and audit.
CREATE OR REPLACE FUNCTION public.gphkm_activate_staff(target_user text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  target_role text;
  target_active boolean;
  target_email_verified boolean;
BEGIN
  IF actor_id IS NULL OR target_user IS NULL OR actor_id = target_user THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('staff-active-admins', 0));
  IF NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT role, active INTO target_role, target_active
    FROM public.staff_account WHERE user_id = target_user FOR UPDATE;
  IF NOT FOUND OR target_role = 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT email_verified INTO target_email_verified
    FROM public.auth_user WHERE id = target_user FOR SHARE;
  IF NOT coalesce(target_email_verified, false) THEN
    RAISE EXCEPTION 'verified staff email required' USING ERRCODE = '23514';
  END IF;
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
