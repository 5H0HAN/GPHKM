-- Immutable supplier/order packet snapshots and per-attempt transport evidence.
ALTER TABLE order_item_fulfillment ADD COLUMN handed_off_at timestamptz;

CREATE TABLE supplier_packet (
  id text PRIMARY KEY CHECK (id ~ '^pkt_[A-Za-z0-9_-]{6,80}$'),
  version integer NOT NULL CHECK (version > 0),
  organization_id text NOT NULL REFERENCES organization(id),
  order_id text NOT NULL REFERENCES customer_order(id),
  supplier_id text NOT NULL REFERENCES supplier(id),
  recipient text NOT NULL CHECK (length(recipient) BETWEEN 3 AND 254 AND recipient !~ E'[\\r\\n\\x00]'),
  packet jsonb NOT NULL CHECK (jsonb_typeof(packet) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  hold_reason text CHECK (hold_reason IS NULL OR hold_reason IN ('PACKET_SIZE_REVIEW')),
  held_at timestamptz,
  created_by_user_id text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  UNIQUE (order_id, supplier_id, version)
);
CREATE INDEX supplier_packet_order_supplier_idx ON supplier_packet(order_id, supplier_id, created_at);
ALTER TABLE supplier_packet ENABLE ROW LEVEL SECURITY;

CREATE TABLE supplier_packet_item (
  packet_id text NOT NULL REFERENCES supplier_packet(id),
  order_item_id text NOT NULL REFERENCES customer_order_item(id),
  assigned_admin_id text NOT NULL REFERENCES auth_user(id),
  consent_notice_version text NOT NULL CHECK (length(consent_notice_version) BETWEEN 1 AND 80),
  consented_at timestamptz NOT NULL,
  consent_content_hash text NOT NULL CHECK (consent_content_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (packet_id, order_item_id)
);
CREATE INDEX supplier_packet_item_order_item_idx ON supplier_packet_item(order_item_id);
ALTER TABLE supplier_packet_item ENABLE ROW LEVEL SECURITY;

CREATE TABLE supplier_packet_attempt (
  id text PRIMARY KEY,
  packet_id text NOT NULL REFERENCES supplier_packet(id),
  type text NOT NULL CHECK (type IN ('SEND','EML_EXPORT','PDF_EXPORT','MANUAL_SENT')),
  state text NOT NULL CHECK (state IN ('SENDING','ACCEPTED','DELIVERED','DELIVERY_ISSUE','UNKNOWN','EXPORTED','MANUAL_SENT','RECONCILED_FAILED')),
  actor_user_id text NOT NULL REFERENCES auth_user(id),
  recipient text NOT NULL CHECK (length(recipient) BETWEEN 3 AND 254 AND recipient !~ E'[\\r\\n\\x00]'),
  idempotency_key text NOT NULL UNIQUE,
  resend_reason text CHECK (resend_reason IS NULL OR length(trim(resend_reason)) BETWEEN 1 AND 1000),
  provider text,
  provider_reference text,
  manual_message_reference text,
  sent_at timestamptz,
  accepted_at timestamptz,
  delivered_at timestamptz,
  unknown_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'SEND' AND provider = 'RESEND' AND state NOT IN ('EXPORTED','MANUAL_SENT'))
    OR (type IN ('EML_EXPORT','PDF_EXPORT') AND state = 'EXPORTED' AND provider IS NULL)
    OR (type = 'MANUAL_SENT' AND state = 'MANUAL_SENT' AND provider IS NULL AND manual_message_reference IS NOT NULL AND sent_at IS NOT NULL))
);
CREATE INDEX supplier_packet_attempt_packet_created_idx ON supplier_packet_attempt(packet_id, created_at);
CREATE INDEX supplier_packet_attempt_provider_reference_idx ON supplier_packet_attempt(provider, provider_reference);
ALTER TABLE supplier_packet_attempt ENABLE ROW LEVEL SECURITY;

CREATE TABLE supplier_packet_attempt_event (
  id text PRIMARY KEY,
  attempt_id text REFERENCES supplier_packet_attempt(id),
  actor_user_id text REFERENCES auth_user(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('STAFF','PROVIDER')),
  from_state text,
  to_state text NOT NULL,
  reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 100),
  reference text CHECK (reference IS NULL OR length(reference) <= 320),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_packet_attempt_event_history_idx ON supplier_packet_attempt_event(attempt_id, created_at);
ALTER TABLE supplier_packet_attempt_event ENABLE ROW LEVEL SECURITY;

CREATE TABLE supplier_packet_provider_event (
  id text PRIMARY KEY,
  provider_event_id text NOT NULL UNIQUE,
  attempt_id text REFERENCES supplier_packet_attempt(id),
  event_type text NOT NULL CHECK (event_type IN ('email.delivered','email.bounced','email.failed','email.delivery_delayed')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'PROCESSED' CHECK (state IN ('PROCESSED','RECONCILIATION_REQUIRED')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
ALTER TABLE supplier_packet_provider_event ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.gphkm_supplier_packet_access(target_packet text, target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_is_active_staff(target_user, 'SUPER_ADMIN') OR (
    public.gphkm_is_active_staff(target_user, 'ADMIN') AND EXISTS (
      SELECT 1 FROM public.supplier_packet_item pi WHERE pi.packet_id = target_packet
    ) AND NOT EXISTS (
      SELECT 1 FROM public.supplier_packet_item pi
      LEFT JOIN public.order_item_fulfillment f ON f.order_item_id = pi.order_item_id
      WHERE pi.packet_id = target_packet
        AND (pi.assigned_admin_id IS DISTINCT FROM target_user OR f.assigned_admin_id IS DISTINCT FROM target_user)
    )
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_packet_access(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_supplier_packet_access(text,text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_packet_item_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE packet_row public.supplier_packet%ROWTYPE; fulfillment_row public.order_item_fulfillment%ROWTYPE;
  item_order text; actual_org text; actual_notice text; actual_consented_at timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'packet item membership is immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO packet_row FROM public.supplier_packet WHERE id = NEW.packet_id;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment WHERE order_item_id = NEW.order_item_id;
  SELECT oi.order_id, o.organization_id, oi.consent_notice_version, oi.consented_at
    INTO item_order, actual_org, actual_notice, actual_consented_at
    FROM public.customer_order_item oi JOIN public.customer_order o ON o.id = oi.order_id
   WHERE oi.id = NEW.order_item_id;
  IF NOT FOUND OR packet_row.id IS NULL OR fulfillment_row.order_item_id IS NULL
    OR item_order <> packet_row.order_id OR actual_org <> packet_row.organization_id
    OR fulfillment_row.assigned_admin_id <> NEW.assigned_admin_id
    OR fulfillment_row.state <> 'READY_FOR_HANDOFF'
    OR actual_notice <> NEW.consent_notice_version OR actual_consented_at <> NEW.consented_at
    OR NOT EXISTS (SELECT 1 FROM public.order_item_fulfillment_supplier fs
      WHERE fs.order_item_id = NEW.order_item_id AND fs.supplier_id = packet_row.supplier_id) THEN
    RAISE EXCEPTION 'packet item does not match the order-time fulfillment snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_packet_item_guard() FROM PUBLIC;
CREATE TRIGGER supplier_packet_item_guard BEFORE INSERT OR UPDATE OR DELETE ON supplier_packet_item
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_packet_item_guard();

CREATE FUNCTION public.gphkm_require_packet_items() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.supplier_packet_item WHERE packet_id = NEW.id) THEN
    RAISE EXCEPTION 'supplier packet must contain at least one item' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_require_packet_items() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER supplier_packet_requires_items AFTER INSERT ON supplier_packet
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.gphkm_require_packet_items();

CREATE FUNCTION public.gphkm_packet_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR
    (NEW.id, NEW.version, NEW.organization_id, NEW.order_id, NEW.supplier_id, NEW.recipient, NEW.packet,
      NEW.content_hash, NEW.created_by_user_id, NEW.created_at)
    IS DISTINCT FROM
    (OLD.id, OLD.version, OLD.organization_id, OLD.order_id, OLD.supplier_id, OLD.recipient, OLD.packet,
      OLD.content_hash, OLD.created_by_user_id, OLD.created_at)
    OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
    RAISE EXCEPTION 'supplier packet snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_packet_immutable() FROM PUBLIC;
CREATE TRIGGER supplier_packet_immutable BEFORE UPDATE OR DELETE ON supplier_packet FOR EACH ROW EXECUTE FUNCTION public.gphkm_packet_immutable();

CREATE FUNCTION public.gphkm_packet_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE latest_event public.supplier_packet_attempt_event%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.type = 'SEND' AND NEW.state <> 'SENDING' OR NEW.type IN ('EML_EXPORT','PDF_EXPORT') AND NEW.state <> 'EXPORTED'
      OR NEW.type = 'MANUAL_SENT' AND NEW.state <> 'MANUAL_SENT' THEN
      RAISE EXCEPTION 'invalid initial supplier packet attempt state' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' OR (NEW.id,NEW.packet_id,NEW.type,NEW.actor_user_id,NEW.recipient,NEW.idempotency_key,
      NEW.resend_reason,NEW.provider,NEW.manual_message_reference,NEW.sent_at,NEW.created_at)
    IS DISTINCT FROM
      (OLD.id,OLD.packet_id,OLD.type,OLD.actor_user_id,OLD.recipient,OLD.idempotency_key,
      OLD.resend_reason,OLD.provider,OLD.manual_message_reference,OLD.sent_at,OLD.created_at) THEN
    RAISE EXCEPTION 'supplier packet attempt identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.state <> OLD.state THEN
    SELECT * INTO latest_event FROM public.supplier_packet_attempt_event e
      WHERE e.attempt_id = OLD.id AND e.actor_user_id IS NOT DISTINCT FROM nullif(current_setting('app.user_id',true),'')
        AND e.from_state IS NOT DISTINCT FROM OLD.state AND e.to_state = NEW.state
        AND e.created_at >= transaction_timestamp() ORDER BY e.created_at DESC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'packet attempt state change requires append-only history' USING ERRCODE = '23514'; END IF;
    IF NOT (
      (OLD.state = 'SENDING' AND NEW.state IN ('ACCEPTED','DELIVERED','UNKNOWN','DELIVERY_ISSUE','RECONCILED_FAILED'))
      OR (OLD.state = 'UNKNOWN' AND NEW.state IN ('ACCEPTED','DELIVERED','DELIVERY_ISSUE','RECONCILED_FAILED'))
      OR (OLD.state = 'ACCEPTED' AND NEW.state IN ('DELIVERED','DELIVERY_ISSUE'))
      OR (OLD.state = 'DELIVERY_ISSUE' AND NEW.state = 'DELIVERED')
    ) THEN RAISE EXCEPTION 'invalid supplier packet attempt transition' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_packet_attempt_guard() FROM PUBLIC;
CREATE TRIGGER supplier_packet_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON supplier_packet_attempt
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_packet_attempt_guard();

CREATE FUNCTION public.gphkm_packet_attempt_event_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'supplier packet attempt history is append-only' USING ERRCODE = '23514'; END IF;
  IF NEW.actor_kind = 'STAFF' AND NEW.actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id',true),'') THEN
    RAISE EXCEPTION 'packet attempt actor mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_packet_attempt_event_guard() FROM PUBLIC;
CREATE TRIGGER supplier_packet_attempt_event_guard BEFORE INSERT OR UPDATE OR DELETE ON supplier_packet_attempt_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_packet_attempt_event_guard();

CREATE POLICY supplier_packet_staff_read ON supplier_packet FOR SELECT TO gphkm_runtime USING (
  public.gphkm_supplier_packet_access(id, nullif(current_setting('app.user_id',true),''))
);
CREATE POLICY supplier_packet_webhook_read ON supplier_packet FOR SELECT TO gphkm_runtime USING (
  nullif(current_setting('app.resend_webhook_verified',true),'') = 'true'
  AND EXISTS (SELECT 1 FROM public.supplier_packet_attempt a WHERE a.packet_id = supplier_packet.id
    AND a.provider = 'RESEND' AND a.provider_reference = nullif(current_setting('app.resend_webhook_email_id',true),''))
);
CREATE POLICY supplier_packet_staff_insert ON supplier_packet FOR INSERT TO gphkm_runtime WITH CHECK (
  created_by_user_id = nullif(current_setting('app.user_id',true),'') AND
  (public.gphkm_is_active_staff(created_by_user_id,'ADMIN') OR public.gphkm_is_active_staff(created_by_user_id,'SUPER_ADMIN'))
);
CREATE POLICY supplier_packet_staff_update ON supplier_packet FOR UPDATE TO gphkm_runtime USING (
  public.gphkm_supplier_packet_access(id, nullif(current_setting('app.user_id',true),''))
) WITH CHECK (
  public.gphkm_supplier_packet_access(id, nullif(current_setting('app.user_id',true),''))
);

CREATE POLICY supplier_packet_item_staff_read ON supplier_packet_item FOR SELECT TO gphkm_runtime USING (
  public.gphkm_supplier_packet_access(packet_id, nullif(current_setting('app.user_id',true),''))
);
CREATE POLICY supplier_packet_item_webhook_read ON supplier_packet_item FOR SELECT TO gphkm_runtime USING (
  nullif(current_setting('app.resend_webhook_verified',true),'') = 'true'
  AND EXISTS (SELECT 1 FROM public.supplier_packet_attempt a WHERE a.packet_id = supplier_packet_item.packet_id
    AND a.provider = 'RESEND' AND a.provider_reference = nullif(current_setting('app.resend_webhook_email_id',true),''))
);
CREATE POLICY supplier_packet_item_staff_insert ON supplier_packet_item FOR INSERT TO gphkm_runtime WITH CHECK (
  assigned_admin_id = nullif(current_setting('app.user_id',true),'')
    AND public.gphkm_is_active_staff(assigned_admin_id,'ADMIN')
    AND public.gphkm_is_active_staff(nullif(current_setting('app.user_id',true),''),'ADMIN')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id',true),''),'SUPER_ADMIN')
);

CREATE POLICY supplier_packet_attempt_staff_read ON supplier_packet_attempt FOR SELECT TO gphkm_runtime USING (
  public.gphkm_supplier_packet_access(packet_id, nullif(current_setting('app.user_id',true),''))
);
CREATE POLICY supplier_packet_attempt_webhook_read ON supplier_packet_attempt FOR SELECT TO gphkm_runtime USING (
  nullif(current_setting('app.resend_webhook_verified',true),'') = 'true'
);
CREATE POLICY supplier_packet_attempt_staff_insert ON supplier_packet_attempt FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id',true),'')
  AND public.gphkm_supplier_packet_access(packet_id, actor_user_id)
);
CREATE POLICY supplier_packet_attempt_staff_update ON supplier_packet_attempt FOR UPDATE TO gphkm_runtime USING (
  public.gphkm_supplier_packet_access(packet_id, nullif(current_setting('app.user_id',true),''))
) WITH CHECK (
  public.gphkm_supplier_packet_access(packet_id, nullif(current_setting('app.user_id',true),''))
);
CREATE POLICY supplier_packet_attempt_event_staff_read ON supplier_packet_attempt_event FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM public.supplier_packet_attempt a WHERE a.id = attempt_id
    AND public.gphkm_supplier_packet_access(a.packet_id, nullif(current_setting('app.user_id',true),'')))
);
CREATE POLICY supplier_packet_attempt_event_staff_insert ON supplier_packet_attempt_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_kind = 'STAFF' AND actor_user_id = nullif(current_setting('app.user_id',true),'')
  AND EXISTS (SELECT 1 FROM public.supplier_packet_attempt a WHERE a.id = attempt_id
    AND public.gphkm_supplier_packet_access(a.packet_id, actor_user_id))
);
CREATE POLICY supplier_packet_provider_event_staff_read ON supplier_packet_provider_event FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM public.supplier_packet_attempt a WHERE a.id = attempt_id
    AND public.gphkm_supplier_packet_access(a.packet_id, nullif(current_setting('app.user_id',true),'')))
  OR (attempt_id IS NULL AND public.gphkm_is_active_staff(nullif(current_setting('app.user_id',true),''),'SUPER_ADMIN'))
);
CREATE POLICY supplier_packet_provider_event_webhook_insert ON supplier_packet_provider_event FOR INSERT TO gphkm_runtime WITH CHECK (
  nullif(current_setting('app.resend_webhook_verified',true),'') = 'true'
);
CREATE POLICY supplier_packet_attempt_event_webhook_insert ON supplier_packet_attempt_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_kind = 'PROVIDER' AND actor_user_id IS NULL
  AND nullif(current_setting('app.resend_webhook_verified',true),'') = 'true'
);
CREATE POLICY supplier_packet_attempt_webhook_update ON supplier_packet_attempt FOR UPDATE TO gphkm_runtime USING (
  nullif(current_setting('app.resend_webhook_verified',true),'') = 'true'
) WITH CHECK (nullif(current_setting('app.resend_webhook_verified',true),'') = 'true');

CREATE POLICY audit_event_resend_webhook_insert ON audit_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id IS NULL
  AND nullif(current_setting('app.resend_webhook_verified',true),'') = 'true'
  AND action = 'FULFILLMENT_STATE_CHANGED'
  AND target_type = 'CUSTOMER_ORDER_ITEM'
  AND reason_code = 'PROVIDER_DELIVERED'
  AND EXISTS (
    SELECT 1 FROM public.supplier_packet_attempt a
    JOIN public.supplier_packet_item pi ON pi.packet_id = a.packet_id
    JOIN public.supplier_packet p ON p.id = a.packet_id
    WHERE pi.order_item_id = audit_event.target_id
      AND p.organization_id = audit_event.organization_id
      AND a.provider = 'RESEND'
      AND a.provider_reference = nullif(current_setting('app.resend_webhook_email_id',true),'')
  )
);

CREATE FUNCTION public.gphkm_resend_webhook_can_update_item(target_item text, target_email_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.supplier_packet_attempt a
    JOIN public.supplier_packet_item pi ON pi.packet_id = a.packet_id
    WHERE a.provider = 'RESEND' AND a.provider_reference = target_email_id AND pi.order_item_id = target_item
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_resend_webhook_can_update_item(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_resend_webhook_can_update_item(text,text) TO gphkm_runtime;
CREATE POLICY order_item_fulfillment_resend_webhook_update ON order_item_fulfillment FOR UPDATE TO gphkm_runtime USING (
  nullif(current_setting('app.resend_webhook_verified',true),'') = 'true'
  AND public.gphkm_resend_webhook_can_update_item(order_item_id, nullif(current_setting('app.resend_webhook_email_id',true),''))
) WITH CHECK (
  nullif(current_setting('app.resend_webhook_verified',true),'') = 'true'
  AND public.gphkm_resend_webhook_can_update_item(order_item_id, nullif(current_setting('app.resend_webhook_email_id',true),''))
);
CREATE POLICY order_item_fulfillment_resend_webhook_read ON order_item_fulfillment FOR SELECT TO gphkm_runtime USING (
  nullif(current_setting('app.resend_webhook_verified',true),'') = 'true'
  AND public.gphkm_resend_webhook_can_update_item(order_item_id, nullif(current_setting('app.resend_webhook_email_id',true),''))
);

GRANT SELECT, INSERT, UPDATE ON supplier_packet TO gphkm_runtime;
GRANT SELECT, INSERT ON supplier_packet_item TO gphkm_runtime;
GRANT SELECT, INSERT, UPDATE ON supplier_packet_attempt TO gphkm_runtime;
GRANT SELECT, INSERT ON supplier_packet_attempt_event, supplier_packet_provider_event TO gphkm_runtime;
REVOKE DELETE ON supplier_packet, supplier_packet_item, supplier_packet_attempt,
  supplier_packet_attempt_event, supplier_packet_provider_event FROM gphkm_runtime;
REVOKE UPDATE, DELETE ON supplier_packet_item, supplier_packet_attempt_event, supplier_packet_provider_event FROM gphkm_runtime;
