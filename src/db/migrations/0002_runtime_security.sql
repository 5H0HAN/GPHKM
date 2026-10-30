-- Tenant policies and money/audit protections for the restricted application role.
-- This role must not own public tables and must not have BYPASSRLS.
ALTER TABLE organization ADD COLUMN IF NOT EXISTS created_by text;
UPDATE organization o SET created_by = (
  SELECT m.user_id FROM organization_member m
  WHERE m.organization_id = o.id AND m.role = 'OWNER' AND m.active
  ORDER BY m.created_at LIMIT 1
) WHERE created_by IS NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM organization WHERE created_by IS NULL) THEN
    RAISE EXCEPTION 'Cannot migrate organizations without an active owner';
  END IF;
END $$;
ALTER TABLE organization ALTER COLUMN created_by SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS organization_created_by_unique ON organization(created_by);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_created_by_auth_user_id_fk') THEN
    ALTER TABLE organization ADD CONSTRAINT organization_created_by_auth_user_id_fk
      FOREIGN KEY (created_by) REFERENCES auth_user(id);
  END IF;
END $$;
ALTER TABLE organization ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
ALTER TABLE access_policy ALTER COLUMN updated_by DROP NOT NULL;
ALTER TABLE access_policy ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';
ALTER TABLE wallet_account ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
ALTER TABLE wallet_account ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';
ALTER TABLE wallet_ledger_entry ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
ALTER TABLE payment_attempt ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
ALTER TABLE payment_attempt ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';
ALTER TABLE payment_attempt ALTER COLUMN settled_at TYPE timestamptz USING settled_at AT TIME ZONE 'UTC';
ALTER TABLE access_grant ALTER COLUMN starts_at TYPE timestamptz USING starts_at AT TIME ZONE 'UTC';
ALTER TABLE access_grant ALTER COLUMN ends_at TYPE timestamptz USING ends_at AT TIME ZONE 'UTC';
ALTER TABLE access_grant ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
ALTER TABLE access_grant ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';
ALTER TABLE wallet_hold ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
ALTER TABLE wallet_hold ALTER COLUMN released_at TYPE timestamptz USING released_at AT TIME ZONE 'UTC';
ALTER TABLE audit_event ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
ALTER TABLE provider_event ALTER COLUMN received_at TYPE timestamptz USING received_at AT TIME ZONE 'UTC';
ALTER TABLE provider_event ALTER COLUMN processed_at TYPE timestamptz USING processed_at AT TIME ZONE 'UTC';
ALTER TABLE provider_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_policy ENABLE ROW LEVEL SECURITY;
INSERT INTO wallet_account (organization_id, currency)
  SELECT id, 'USD' FROM organization ON CONFLICT (organization_id) DO NOTHING;
INSERT INTO access_policy (id, minimum_minor, duration, version, updated_by)
  VALUES (1, 5000, 'SIX_MONTHS', 1, NULL) ON CONFLICT (id) DO NOTHING;
GRANT USAGE ON SCHEMA public TO gphkm_runtime;
GRANT SELECT, INSERT, UPDATE ON organization TO gphkm_runtime;
GRANT SELECT, INSERT, UPDATE ON organization_member TO gphkm_runtime;
GRANT SELECT, INSERT ON wallet_account TO gphkm_runtime;
GRANT SELECT, INSERT ON wallet_ledger_entry TO gphkm_runtime;
GRANT SELECT ON payment_attempt, access_grant TO gphkm_runtime;
GRANT SELECT ON wallet_hold TO gphkm_runtime;
GRANT SELECT, INSERT, UPDATE ON audit_event TO gphkm_runtime;
GRANT SELECT, UPDATE ON access_policy TO gphkm_runtime;
GRANT SELECT ON provider_event TO gphkm_runtime;
REVOKE UPDATE, DELETE ON wallet_account, wallet_ledger_entry, audit_event FROM gphkm_runtime;
REVOKE INSERT, UPDATE, DELETE ON payment_attempt, access_grant, wallet_hold, provider_event FROM gphkm_runtime;
REVOKE INSERT, DELETE ON access_policy FROM gphkm_runtime;
REVOKE DELETE ON organization, organization_member FROM gphkm_runtime;

-- SECURITY DEFINER helpers avoid recursive RLS policies on organization_member.
CREATE FUNCTION public.gphkm_is_active_org_member(target_org text, target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organization_member m
    WHERE m.organization_id = target_org AND m.user_id = target_user AND m.active)
$$;
CREATE FUNCTION public.gphkm_is_active_org_owner(target_org text, target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organization_member m
    WHERE m.organization_id = target_org AND m.user_id = target_user AND m.active AND m.role = 'OWNER')
$$;
CREATE FUNCTION public.gphkm_org_created_by(target_org text, target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organization o
    WHERE o.id = target_org AND o.created_by = target_user)
$$;
REVOKE ALL ON FUNCTION public.gphkm_is_active_org_member(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gphkm_is_active_org_owner(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gphkm_org_created_by(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_is_active_org_member(text, text) TO gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_is_active_org_owner(text, text) TO gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_org_created_by(text, text) TO gphkm_runtime;

CREATE POLICY organization_read_member ON organization FOR SELECT TO gphkm_runtime
  USING (public.gphkm_is_active_org_member(organization.id, nullif(current_setting('app.user_id', true), '')));
CREATE POLICY organization_create_self ON organization FOR INSERT TO gphkm_runtime
  WITH CHECK (created_by = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY organization_update_owner ON organization FOR UPDATE TO gphkm_runtime
  USING (public.gphkm_is_active_org_owner(organization.id, nullif(current_setting('app.user_id', true), '')))
  WITH CHECK (public.gphkm_is_active_org_owner(organization.id, nullif(current_setting('app.user_id', true), '')));

CREATE POLICY organization_member_read_self_or_tenant ON organization_member FOR SELECT TO gphkm_runtime
  USING (
    user_id = nullif(current_setting('app.user_id', true), '')
    OR organization_id = nullif(current_setting('app.organization_id', true), '')
  );
CREATE POLICY organization_member_create_owner_or_invitee ON organization_member FOR INSERT TO gphkm_runtime
  WITH CHECK (
    (user_id = nullif(current_setting('app.user_id', true), '') AND role = 'OWNER'
      AND public.gphkm_org_created_by(organization_id, nullif(current_setting('app.user_id', true), '')))
    OR (organization_id = nullif(current_setting('app.organization_id', true), '')
      AND public.gphkm_is_active_org_owner(organization_member.organization_id,
        nullif(current_setting('app.user_id', true), '')))
  );
CREATE POLICY organization_member_update_owner ON organization_member FOR UPDATE TO gphkm_runtime
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')
    AND public.gphkm_is_active_org_owner(organization_member.organization_id,
      nullif(current_setting('app.user_id', true), '')))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY wallet_account_tenant_read ON wallet_account FOR SELECT TO gphkm_runtime
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY wallet_account_tenant_create ON wallet_account FOR INSERT TO gphkm_runtime
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY wallet_ledger_tenant_read ON wallet_ledger_entry FOR SELECT TO gphkm_runtime
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY wallet_ledger_tenant_insert ON wallet_ledger_entry FOR INSERT TO gphkm_runtime
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND (
      (kind = 'ORDER_DEBIT' AND delta_minor < 0)
      OR (kind = 'ITEM_REFUND' AND EXISTS (SELECT 1 FROM staff_account s
        WHERE s.user_id = nullif(current_setting('app.user_id', true), '') AND s.active))
      OR (kind = 'ADJUSTMENT' AND EXISTS (SELECT 1 FROM staff_account s
        WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
          AND s.active AND s.role IN ('FINANCE', 'SUPER_ADMIN')))
    )
  );
CREATE POLICY payment_attempt_tenant_read ON payment_attempt FOR SELECT TO gphkm_runtime
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY access_grant_tenant_read ON access_grant FOR SELECT TO gphkm_runtime
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY wallet_hold_tenant_read ON wallet_hold FOR SELECT TO gphkm_runtime
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY audit_event_tenant_read ON audit_event FOR SELECT TO gphkm_runtime
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')
    OR EXISTS (SELECT 1 FROM staff_account s
      WHERE s.user_id = nullif(current_setting('app.user_id', true), '') AND s.active));
CREATE POLICY audit_event_tenant_insert ON audit_event FOR INSERT TO gphkm_runtime
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')
    OR EXISTS (SELECT 1 FROM staff_account s
      WHERE s.user_id = nullif(current_setting('app.user_id', true), '') AND s.active));
CREATE POLICY access_policy_read ON access_policy FOR SELECT TO gphkm_runtime USING (true);
CREATE POLICY access_policy_super_admin_write ON access_policy FOR UPDATE TO gphkm_runtime
  USING (EXISTS (SELECT 1 FROM staff_account s
    WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
      AND s.active AND s.role = 'SUPER_ADMIN'))
  WITH CHECK (EXISTS (SELECT 1 FROM staff_account s
    WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
      AND s.active AND s.role = 'SUPER_ADMIN'));
CREATE POLICY provider_event_staff_read ON provider_event FOR SELECT TO gphkm_runtime
  USING (EXISTS (SELECT 1 FROM staff_account s
    WHERE s.user_id = nullif(current_setting('app.user_id', true), '') AND s.active
      AND s.role IN ('FINANCE', 'SUPER_ADMIN')));

-- Keep the projection writable only by the trigger owner; all wallet changes start as ledger rows.
CREATE FUNCTION public.gphkm_apply_wallet_delta() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE updated_rows integer;
BEGIN
  UPDATE public.wallet_account
     SET balance_minor = balance_minor + NEW.delta_minor,
         updated_at = now()
   WHERE organization_id = NEW.organization_id
     AND balance_minor + NEW.delta_minor >= 0;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  IF updated_rows <> 1 THEN
    RAISE EXCEPTION 'wallet projection missing or insufficient funds' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_apply_wallet_delta() FROM PUBLIC;
CREATE TRIGGER wallet_ledger_apply_projection
  AFTER INSERT ON wallet_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_apply_wallet_delta();

CREATE FUNCTION public.gphkm_reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'immutable record cannot be changed' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_immutable_mutation() FROM PUBLIC;
CREATE TRIGGER wallet_ledger_immutable
  BEFORE UPDATE OR DELETE ON wallet_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_immutable_mutation();
CREATE TRIGGER audit_event_immutable
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_immutable_mutation();

-- Prevent a future grant's dates from being silently rewritten during dispute resolution.
CREATE FUNCTION public.gphkm_preserve_grant_interval() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.ledger_entry_id <> OLD.ledger_entry_id
     OR NEW.starts_at <> OLD.starts_at OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
     OR NEW.duration <> OLD.duration OR NEW.policy_version <> OLD.policy_version THEN
    RAISE EXCEPTION 'recorded access grant interval is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_preserve_grant_interval() FROM PUBLIC;
CREATE TRIGGER access_grant_preserve_interval
  BEFORE UPDATE ON access_grant
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_preserve_grant_interval();
