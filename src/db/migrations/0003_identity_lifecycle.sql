-- Customer organization invitations and exact-session staff MFA proof.
CREATE TYPE organization_invitation_status AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');
CREATE TABLE organization_invitation (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'MEMBER' CHECK (role = 'MEMBER'),
  token_hash text NOT NULL UNIQUE,
  status organization_invitation_status NOT NULL DEFAULT 'PENDING',
  invited_by_user_id text NOT NULL REFERENCES auth_user(id),
  accepted_by_user_id text REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX organization_invitation_org_status_idx ON organization_invitation(organization_id, status);
CREATE UNIQUE INDEX organization_invitation_pending_email_uq
  ON organization_invitation(organization_id, lower(email)) WHERE status = 'PENDING';
ALTER TABLE organization_invitation ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON organization_invitation TO gphkm_runtime;
REVOKE UPDATE ON organization_invitation FROM gphkm_runtime;
GRANT UPDATE (status, accepted_by_user_id, accepted_at, revoked_at) ON organization_invitation TO gphkm_runtime;
REVOKE DELETE ON organization_invitation FROM gphkm_runtime;

CREATE POLICY organization_invitation_owner_read ON organization_invitation FOR SELECT TO gphkm_runtime
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')
    AND public.gphkm_is_active_org_owner(organization_id, nullif(current_setting('app.user_id', true), '')));
CREATE POLICY organization_invitation_owner_create ON organization_invitation FOR INSERT TO gphkm_runtime
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')
    AND invited_by_user_id = nullif(current_setting('app.user_id', true), '')
    AND public.gphkm_is_active_org_owner(organization_id, nullif(current_setting('app.user_id', true), '')));
CREATE POLICY organization_invitation_owner_revoke ON organization_invitation FOR UPDATE TO gphkm_runtime
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')
    AND public.gphkm_is_active_org_owner(organization_id, nullif(current_setting('app.user_id', true), '')))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY organization_invitation_accept_read ON organization_invitation FOR SELECT TO gphkm_runtime
  USING (token_hash = nullif(current_setting('app.invitation_token_hash', true), '')
    AND status = 'PENDING' AND expires_at > now()
    AND lower(email) = (SELECT lower(email) FROM auth_user WHERE id = nullif(current_setting('app.user_id', true), '')));
CREATE POLICY organization_invitation_accept_update ON organization_invitation FOR UPDATE TO gphkm_runtime
  USING (token_hash = nullif(current_setting('app.invitation_token_hash', true), '')
    AND status = 'PENDING' AND expires_at > now()
    AND lower(email) = (SELECT lower(email) FROM auth_user WHERE id = nullif(current_setting('app.user_id', true), '')))
  WITH CHECK (status = 'ACCEPTED' AND accepted_by_user_id = nullif(current_setting('app.user_id', true), ''));

-- Invitation acceptance policy must be narrow, one-time, and bound to verified caller identity.
CREATE FUNCTION public.gphkm_valid_org_invitation(target_org text, target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organization_invitation i
    JOIN public.auth_user u ON u.id = target_user
    WHERE i.organization_id = target_org
      AND i.token_hash = nullif(current_setting('app.invitation_token_hash', true), '')
      AND i.status = 'PENDING' AND i.expires_at > now()
      AND lower(i.email) = lower(u.email))
$$;
REVOKE ALL ON FUNCTION public.gphkm_valid_org_invitation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_valid_org_invitation(text, text) TO gphkm_runtime;
DROP POLICY organization_member_create_owner_or_invitee ON organization_member;
CREATE POLICY organization_member_create_owner_or_invitee ON organization_member FOR INSERT TO gphkm_runtime
  WITH CHECK (
    (user_id = nullif(current_setting('app.user_id', true), '') AND role = 'OWNER'
      AND public.gphkm_org_created_by(organization_id, nullif(current_setting('app.user_id', true), '')))
    OR (organization_id = nullif(current_setting('app.organization_id', true), '')
      AND public.gphkm_is_active_org_owner(organization_member.organization_id,
        nullif(current_setting('app.user_id', true), '')))
    OR (user_id = nullif(current_setting('app.user_id', true), '') AND role = 'MEMBER'
      AND public.gphkm_valid_org_invitation(organization_member.organization_id,
        nullif(current_setting('app.user_id', true), '')))
  );

CREATE TYPE staff_mfa_method AS ENUM ('TOTP', 'BACKUP_CODE', 'OTP');
CREATE TABLE staff_mfa_session (
  session_id text PRIMARY KEY REFERENCES auth_session(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  method staff_mfa_method NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_mfa_session_user_idx ON staff_mfa_session(user_id);
ALTER TABLE staff_mfa_session ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_mfa_session TO gphkm_runtime;
CREATE FUNCTION public.gphkm_is_active_staff(target_user text, required_role text DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.staff_account s
    WHERE s.user_id = target_user AND s.active
      AND (required_role IS NULL OR s.role = required_role))
$$;
REVOKE ALL ON FUNCTION public.gphkm_is_active_staff(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_is_active_staff(text, text) TO gphkm_runtime;
ALTER TABLE staff_account ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON staff_account TO gphkm_runtime;
REVOKE DELETE ON staff_account FROM gphkm_runtime;
CREATE POLICY staff_account_self_or_super_read ON staff_account FOR SELECT TO gphkm_runtime
  USING (user_id = nullif(current_setting('app.user_id', true), '')
    OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN'));
CREATE POLICY staff_account_super_admin_update ON staff_account FOR UPDATE TO gphkm_runtime
  USING (public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN'))
  WITH CHECK (public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN'));
CREATE POLICY staff_mfa_session_self_read ON staff_mfa_session FOR SELECT TO gphkm_runtime
  USING (user_id = nullif(current_setting('app.user_id', true), '')
    AND EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = staff_mfa_session.user_id AND s.active));
CREATE POLICY staff_mfa_session_verified_insert ON staff_mfa_session FOR INSERT TO gphkm_runtime
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')
    AND EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = staff_mfa_session.user_id AND s.active)
    AND EXISTS (SELECT 1 FROM auth_session a WHERE a.id = staff_mfa_session.session_id AND a.user_id = staff_mfa_session.user_id AND a.expires_at > now()));
CREATE POLICY staff_mfa_session_self_update ON staff_mfa_session FOR UPDATE TO gphkm_runtime
  USING (user_id = nullif(current_setting('app.user_id', true), '')
    AND EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = staff_mfa_session.user_id AND s.active))
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));

CREATE TYPE staff_invitation_role AS ENUM ('ADMIN', 'FINANCE');
CREATE TYPE staff_invitation_status AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');
CREATE TABLE staff_invitation (
  id text PRIMARY KEY,
  email text NOT NULL,
  role staff_invitation_role NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status staff_invitation_status NOT NULL DEFAULT 'PENDING',
  invited_by_user_id text NOT NULL REFERENCES auth_user(id),
  accepted_by_user_id text REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX staff_invitation_status_idx ON staff_invitation(status);
CREATE UNIQUE INDEX staff_invitation_pending_email_uq ON staff_invitation(lower(email)) WHERE status = 'PENDING';
ALTER TABLE staff_invitation ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON staff_invitation TO gphkm_runtime;
REVOKE UPDATE ON staff_invitation FROM gphkm_runtime;
GRANT UPDATE (status, accepted_by_user_id, accepted_at, revoked_at) ON staff_invitation TO gphkm_runtime;
REVOKE DELETE ON staff_invitation FROM gphkm_runtime;
CREATE POLICY staff_invitation_super_admin_read ON staff_invitation FOR SELECT TO gphkm_runtime
  USING (EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '') AND s.active AND s.role = 'SUPER_ADMIN'));
CREATE POLICY staff_invitation_super_admin_create ON staff_invitation FOR INSERT TO gphkm_runtime
  WITH CHECK (invited_by_user_id = nullif(current_setting('app.user_id', true), '')
    AND EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '') AND s.active AND s.role = 'SUPER_ADMIN'));
CREATE POLICY staff_invitation_super_admin_update ON staff_invitation FOR UPDATE TO gphkm_runtime
  USING (EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '') AND s.active AND s.role = 'SUPER_ADMIN'))
  WITH CHECK (EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '') AND s.active AND s.role = 'SUPER_ADMIN'));
CREATE POLICY staff_invitation_accept_read ON staff_invitation FOR SELECT TO gphkm_runtime
  USING (token_hash = nullif(current_setting('app.staff_invitation_token_hash', true), '')
    AND status = 'PENDING' AND expires_at > now()
    AND lower(email) = (SELECT lower(email) FROM auth_user WHERE id = nullif(current_setting('app.user_id', true), '')));
CREATE POLICY staff_invitation_accept_update ON staff_invitation FOR UPDATE TO gphkm_runtime
  USING (token_hash = nullif(current_setting('app.staff_invitation_token_hash', true), '')
    AND status = 'PENDING' AND expires_at > now()
    AND lower(email) = (SELECT lower(email) FROM auth_user WHERE id = nullif(current_setting('app.user_id', true), '')))
  WITH CHECK (status = 'ACCEPTED' AND accepted_by_user_id = nullif(current_setting('app.user_id', true), ''));

-- Accepting a staff invitation can only create the invited Admin/Finance identity.
CREATE FUNCTION public.gphkm_valid_staff_invitation(target_user text, target_role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.staff_invitation i
    JOIN public.auth_user u ON u.id = target_user
    WHERE i.token_hash = nullif(current_setting('app.staff_invitation_token_hash', true), '')
      AND i.status = 'PENDING' AND i.expires_at > now()
      AND i.accepted_by_user_id IS NULL
      AND i.role::text = target_role
      AND lower(i.email) = lower(u.email))
$$;
REVOKE ALL ON FUNCTION public.gphkm_valid_staff_invitation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_valid_staff_invitation(text, text) TO gphkm_runtime;
CREATE POLICY staff_account_invitation_accept ON staff_account FOR INSERT TO gphkm_runtime
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '') AND active = false
    AND public.gphkm_valid_staff_invitation(staff_account.user_id, staff_account.role));
