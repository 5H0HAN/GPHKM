-- Versioned customer legal acceptance. Intentionally not journaled/applied here.
CREATE TABLE customer_legal_acceptance (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_user(id),
  actor_user_id text NOT NULL REFERENCES auth_user(id),
  terms_version text NOT NULL CHECK (terms_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
  privacy_version text NOT NULL CHECK (privacy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
  terms_url text NOT NULL CHECK (length(terms_url) BETWEEN 8 AND 2048),
  privacy_url text NOT NULL CHECK (length(privacy_url) BETWEEN 8 AND 2048),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id = actor_user_id),
  CONSTRAINT customer_legal_acceptance_user_versions_uq UNIQUE (user_id, terms_version, privacy_version)
);
CREATE INDEX customer_legal_acceptance_user_time_idx ON customer_legal_acceptance(user_id, accepted_at);
ALTER TABLE customer_legal_acceptance ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON customer_legal_acceptance TO gphkm_runtime;
REVOKE UPDATE, DELETE ON customer_legal_acceptance FROM gphkm_runtime;
CREATE POLICY customer_legal_acceptance_self_read ON customer_legal_acceptance FOR SELECT TO gphkm_runtime USING (
  user_id = nullif(current_setting('app.user_id',true),'')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id',true),''),'SUPER_ADMIN')
);
CREATE POLICY customer_legal_acceptance_self_insert ON customer_legal_acceptance FOR INSERT TO gphkm_runtime WITH CHECK (
  user_id = nullif(current_setting('app.user_id',true),'') AND actor_user_id = user_id
);
-- Acceptance can precede organization creation; this narrowly permits its linked
-- audit event without granting arbitrary unscoped customer audit writes.
CREATE POLICY audit_event_legal_acceptance_insert ON audit_event FOR INSERT TO gphkm_runtime WITH CHECK (
  organization_id IS NULL AND actor_user_id = nullif(current_setting('app.user_id',true),'')
  AND action = 'CUSTOMER_LEGAL_ACCEPTANCE_RECORDED' AND target_type = 'CUSTOMER_LEGAL_ACCEPTANCE'
  AND EXISTS (SELECT 1 FROM customer_legal_acceptance a WHERE a.id = audit_event.target_id AND a.user_id = audit_event.actor_user_id)
);
CREATE FUNCTION public.gphkm_legal_acceptance_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'legal acceptance evidence is append-only' USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_legal_acceptance_immutable() FROM PUBLIC;
CREATE TRIGGER customer_legal_acceptance_immutable BEFORE UPDATE OR DELETE ON customer_legal_acceptance
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_legal_acceptance_immutable();
