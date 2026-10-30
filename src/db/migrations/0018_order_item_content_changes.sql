-- Customer change requests never update the purchased order snapshot. Approved
-- versions and consent evidence are separate append-only records.
CREATE TABLE order_item_content_change_request (
  id text PRIMARY KEY,
  order_item_id text NOT NULL REFERENCES customer_order_item(id),
  request_number integer NOT NULL CHECK (request_number >= 1),
  requested_by_user_id text NOT NULL REFERENCES auth_user(id),
  base_version integer NOT NULL DEFAULT 1 CHECK (base_version >= 1),
  target_url text,
  anchor_text text,
  article_text text,
  instructions text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_item_id, request_number),
  CHECK (target_url IS NULL OR (length(target_url) BETWEEN 8 AND 2048 AND target_url ~* '^https?://[^/?#[:space:]]+([/?#].*)?$' AND target_url !~* '^https?://[^/@?#]+@' AND target_url !~ '[[:cntrl:][:space:]]')),
  CHECK (anchor_text IS NULL OR length(anchor_text) BETWEEN 1 AND 200),
  CHECK (article_text IS NULL OR length(article_text) BETWEEN 1 AND 20000),
  CHECK (instructions IS NULL OR length(instructions) BETWEEN 1 AND 4000),
  CHECK (num_nonnulls(target_url, anchor_text, article_text, instructions) > 0)
);
CREATE INDEX order_item_content_change_request_item_idx ON order_item_content_change_request(order_item_id, created_at);
ALTER TABLE order_item_content_change_request ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON order_item_content_change_request TO gphkm_runtime;
REVOKE UPDATE, DELETE ON order_item_content_change_request FROM gphkm_runtime;

CREATE TABLE order_item_content_version (
  id text PRIMARY KEY,
  order_item_id text NOT NULL REFERENCES customer_order_item(id),
  request_id text NOT NULL UNIQUE REFERENCES order_item_content_change_request(id),
  version integer NOT NULL CHECK (version >= 2),
  target_url text NOT NULL CHECK (length(target_url) BETWEEN 8 AND 2048 AND target_url ~* '^https?://[^/?#[:space:]]+([/?#].*)?$' AND target_url !~* '^https?://[^/@?#]+@' AND target_url !~ '[[:cntrl:][:space:]]'),
  anchor_text text NOT NULL CHECK (length(anchor_text) BETWEEN 1 AND 200),
  article_text text CHECK (article_text IS NULL OR length(article_text) BETWEEN 1 AND 20000),
  instructions text NOT NULL DEFAULT '' CHECK (length(instructions) <= 4000),
  supplier_id text REFERENCES supplier(id),
  recipient_email text NOT NULL CHECK (length(recipient_email) BETWEEN 1 AND 320),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  approved_by_user_id text NOT NULL REFERENCES auth_user(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_item_id, version)
);
CREATE INDEX order_item_content_version_item_idx ON order_item_content_version(order_item_id, version);
ALTER TABLE order_item_content_version ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON order_item_content_version TO gphkm_runtime;
REVOKE UPDATE, DELETE ON order_item_content_version FROM gphkm_runtime;

CREATE TABLE order_item_content_change_event (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES order_item_content_change_request(id),
  actor_user_id text NOT NULL REFERENCES auth_user(id),
  event_type text NOT NULL CHECK (event_type IN ('REQUESTED', 'APPROVED', 'REJECTED', 'CONSENTED')),
  version_id text REFERENCES order_item_content_version(id),
  content_hash text,
  notice_version text,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((event_type IN ('APPROVED','CONSENTED') AND version_id IS NOT NULL AND content_hash ~ '^[0-9a-f]{64}$' AND
          ((event_type = 'CONSENTED' AND length(notice_version) BETWEEN 1 AND 80) OR (event_type = 'APPROVED' AND notice_version IS NULL)))
      OR (event_type IN ('REQUESTED','REJECTED') AND version_id IS NULL AND content_hash IS NULL AND notice_version IS NULL))
);
CREATE INDEX order_item_content_change_event_request_idx ON order_item_content_change_event(request_id, created_at);
ALTER TABLE order_item_content_change_event ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON order_item_content_change_event TO gphkm_runtime;
REVOKE UPDATE, DELETE ON order_item_content_change_event FROM gphkm_runtime;

CREATE FUNCTION public.gphkm_content_change_customer(target_item_id text, target_user_id text, target_org_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.customer_order_item oi JOIN public.customer_order o ON o.id = oi.order_id
    WHERE oi.id = target_item_id AND o.organization_id = target_org_id
      AND o.actor_user_id = target_user_id
      AND public.gphkm_is_active_org_member(o.organization_id, target_user_id)
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_content_change_customer(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_content_change_customer(text,text,text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_change_request_before_handoff(target_item_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.order_item_fulfillment f WHERE f.order_item_id = target_item_id
    AND f.handed_off_at IS NULL AND f.state NOT IN ('IN_FULFILLMENT','PUBLICATION_PENDING','EVIDENCE_REVIEW','COMPLETED','CANCELED_REFUNDED'))
$$;
REVOKE ALL ON FUNCTION public.gphkm_change_request_before_handoff(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_change_request_before_handoff(text) TO gphkm_runtime;

CREATE POLICY content_change_request_customer_read ON order_item_content_change_request FOR SELECT TO gphkm_runtime USING (
  public.gphkm_content_change_customer(order_item_id, nullif(current_setting('app.user_id', true), ''), nullif(current_setting('app.organization_id', true), ''))
);
CREATE POLICY content_change_request_customer_insert ON order_item_content_change_request FOR INSERT TO gphkm_runtime WITH CHECK (
  requested_by_user_id = nullif(current_setting('app.user_id', true), '')
  AND public.gphkm_content_change_customer(order_item_id, requested_by_user_id, nullif(current_setting('app.organization_id', true), ''))
  AND public.gphkm_change_request_before_handoff(order_item_id)
);
CREATE POLICY content_change_request_assigned_read ON order_item_content_change_request FOR SELECT TO gphkm_runtime USING (
  public.gphkm_staff_can_read_order_item(order_item_id, nullif(current_setting('app.user_id', true), ''))
);
CREATE POLICY content_version_assigned_read ON order_item_content_version FOR SELECT TO gphkm_runtime USING (
  public.gphkm_staff_can_read_order_item(order_item_id, nullif(current_setting('app.user_id', true), ''))
);
CREATE POLICY content_version_assigned_insert ON order_item_content_version FOR INSERT TO gphkm_runtime WITH CHECK (
  approved_by_user_id = nullif(current_setting('app.user_id', true), '')
  AND public.gphkm_staff_can_read_order_item(order_item_id, approved_by_user_id)
  AND public.gphkm_change_request_before_handoff(order_item_id)
);
CREATE POLICY content_change_event_customer_read ON order_item_content_change_event FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM public.order_item_content_change_request r WHERE r.id = request_id
    AND public.gphkm_content_change_customer(r.order_item_id, nullif(current_setting('app.user_id', true), ''), nullif(current_setting('app.organization_id', true), '')))
);
CREATE POLICY content_change_event_assigned_read ON order_item_content_change_event FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM public.order_item_content_change_request r WHERE r.id = request_id
    AND public.gphkm_staff_can_read_order_item(r.order_item_id, nullif(current_setting('app.user_id', true), '')))
);
CREATE POLICY content_change_event_customer_insert ON order_item_content_change_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id', true), '') AND event_type IN ('REQUESTED','CONSENTED')
  AND EXISTS (SELECT 1 FROM public.order_item_content_change_request r WHERE r.id = request_id
    AND public.gphkm_content_change_customer(r.order_item_id, actor_user_id, nullif(current_setting('app.organization_id', true), '')))
);
CREATE POLICY content_change_event_assigned_insert ON order_item_content_change_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id', true), '') AND event_type IN ('APPROVED','REJECTED')
  AND EXISTS (SELECT 1 FROM public.order_item_content_change_request r WHERE r.id = request_id
    AND public.gphkm_staff_can_read_order_item(r.order_item_id, actor_user_id))
);

-- Do not grant customers row access to the version table: each row also stores
-- supplier identity and recipient. This narrow function is the only customer
-- projection of approved content and omits all sourcing fields.
CREATE FUNCTION public.gphkm_customer_approved_content(target_request_id text, target_user_id text, target_org_id text)
RETURNS TABLE(version_id text, version integer, content_hash text, target_url text, anchor_text text, article_text text, instructions text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT v.id, v.version, v.content_hash, v.target_url, v.anchor_text, v.article_text, v.instructions
    FROM public.order_item_content_version v
    JOIN public.order_item_content_change_request r ON r.id = v.request_id
    JOIN public.customer_order_item oi ON oi.id = r.order_item_id
    JOIN public.customer_order o ON o.id = oi.order_id
   WHERE r.id = target_request_id AND r.requested_by_user_id = target_user_id
     AND o.organization_id = target_org_id
     AND public.gphkm_is_active_org_member(o.organization_id, target_user_id)
     AND public.gphkm_change_request_before_handoff(r.order_item_id)
     AND EXISTS (SELECT 1 FROM public.order_item_content_change_event e WHERE e.request_id = r.id AND e.event_type = 'APPROVED' AND e.version_id = v.id)
$$;
REVOKE ALL ON FUNCTION public.gphkm_customer_approved_content(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_customer_approved_content(text,text,text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_reject_content_change_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'content change records are append-only' USING ERRCODE = '42501'; END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_content_change_mutation() FROM PUBLIC;
CREATE TRIGGER content_change_request_append_only BEFORE UPDATE OR DELETE ON order_item_content_change_request
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_content_change_mutation();
CREATE TRIGGER content_version_append_only BEFORE UPDATE OR DELETE ON order_item_content_version
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_content_change_mutation();
CREATE TRIGGER content_change_event_append_only BEFORE UPDATE OR DELETE ON order_item_content_change_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_content_change_mutation();

CREATE FUNCTION public.gphkm_validate_content_change_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE fulfillment_row public.order_item_fulfillment%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.customer_order_item oi WHERE oi.id = NEW.order_item_id) THEN RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment f WHERE f.order_item_id = NEW.order_item_id FOR UPDATE;
  IF NOT FOUND OR fulfillment_row.handed_off_at IS NOT NULL OR fulfillment_row.state IN ('IN_FULFILLMENT','PUBLICATION_PENDING','EVIDENCE_REVIEW','COMPLETED','CANCELED_REFUNDED') THEN
    RAISE EXCEPTION 'content changes close after handoff' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_validate_content_change_request() FROM PUBLIC;
CREATE TRIGGER content_change_request_validate BEFORE INSERT ON order_item_content_change_request
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_validate_content_change_request();

CREATE FUNCTION public.gphkm_require_content_change_resolution_before_handoff() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE latest_version public.order_item_content_version%ROWTYPE; latest_event public.order_item_content_change_event%ROWTYPE; current_email text;
BEGIN
  IF (OLD.handed_off_at IS NULL AND NEW.handed_off_at IS NOT NULL) OR
     (OLD.work_started_at IS NULL AND NEW.work_started_at IS NOT NULL) THEN
    IF EXISTS (
      SELECT 1 FROM public.order_item_content_change_request r
      JOIN LATERAL (SELECT e.event_type FROM public.order_item_content_change_event e
        WHERE e.request_id = r.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) latest ON true
      WHERE r.order_item_id = NEW.order_item_id AND latest.event_type IN ('REQUESTED','APPROVED')
    ) THEN
      RAISE EXCEPTION 'content change request or consent is unresolved' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO latest_version FROM public.order_item_content_version v WHERE v.order_item_id = NEW.order_item_id ORDER BY v.version DESC LIMIT 1;
    IF FOUND THEN
      SELECT * INTO latest_event FROM public.order_item_content_change_event e
        WHERE e.version_id = latest_version.id AND e.event_type = 'CONSENTED' ORDER BY e.created_at DESC, e.id DESC LIMIT 1;
      IF NOT FOUND THEN RAISE EXCEPTION 'latest approved content version lacks customer consent' USING ERRCODE = '23514'; END IF;
      SELECT sc.email INTO current_email FROM public.order_item_fulfillment_supplier fs
      LEFT JOIN public.supplier_contact sc ON sc.supplier_id = fs.supplier_id AND sc.is_primary
      WHERE fs.order_item_id = NEW.order_item_id;
      IF latest_version.supplier_id IS DISTINCT FROM (SELECT fs.supplier_id FROM public.order_item_fulfillment_supplier fs WHERE fs.order_item_id = NEW.order_item_id)
         OR latest_version.recipient_email IS DISTINCT FROM coalesce(current_email, 'GPHKM_INTERNAL') THEN
        RAISE EXCEPTION 'supplier recipient changed after customer consent; refresh consent' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_require_content_change_resolution_before_handoff() FROM PUBLIC;
CREATE TRIGGER fulfillment_requires_resolved_content_changes BEFORE UPDATE OF handed_off_at, work_started_at
  ON order_item_fulfillment FOR EACH ROW EXECUTE FUNCTION public.gphkm_require_content_change_resolution_before_handoff();

CREATE FUNCTION public.gphkm_validate_content_change_event_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE version_row public.order_item_content_version%ROWTYPE; request_item text;
BEGIN
  IF NEW.event_type IN ('APPROVED','CONSENTED') THEN
    IF NEW.version_id IS NULL THEN RAISE EXCEPTION 'approved content event requires a version' USING ERRCODE = '23514'; END IF;
    SELECT * INTO version_row FROM public.order_item_content_version v WHERE v.id = NEW.version_id AND v.request_id = NEW.request_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'content version does not belong to request' USING ERRCODE = '23514'; END IF;
    IF NEW.content_hash IS DISTINCT FROM version_row.content_hash THEN
      RAISE EXCEPTION 'event hash does not match bound content, supplier and recipient' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.event_type = 'CONSENTED' AND NOT public.gphkm_change_request_before_handoff((SELECT r.order_item_id FROM public.order_item_content_change_request r WHERE r.id = NEW.request_id)) THEN
    RAISE EXCEPTION 'content consent closes after handoff' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_validate_content_change_event_binding() FROM PUBLIC;
CREATE TRIGGER content_change_event_binding BEFORE INSERT ON order_item_content_change_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_validate_content_change_event_binding();
