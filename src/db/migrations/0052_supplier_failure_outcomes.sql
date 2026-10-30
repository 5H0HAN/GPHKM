-- Structured supplier inability evidence. Customer projections never include supplier identity or internal reasons.
CREATE TABLE supplier_fulfillment_outcome (
  id text PRIMARY KEY,
  order_item_id text NOT NULL REFERENCES customer_order_item(id),
  supplier_id text NOT NULL REFERENCES supplier(id),
  support_case_id text NOT NULL REFERENCES support_case(id),
  actor_user_id text NOT NULL REFERENCES auth_user(id),
  outcome text NOT NULL CHECK (outcome IN ('REJECTED','CANNOT_FULFILL','NONRESPONSIVE')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 2000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_fulfillment_outcome_idem_uq UNIQUE (order_item_id, actor_user_id, idempotency_key)
);
CREATE INDEX supplier_fulfillment_outcome_supplier_date_idx ON supplier_fulfillment_outcome(supplier_id, created_at);
CREATE INDEX supplier_fulfillment_outcome_item_idx ON supplier_fulfillment_outcome(order_item_id, created_at);
ALTER TABLE supplier_fulfillment_outcome ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON supplier_fulfillment_outcome FROM PUBLIC, gphkm_runtime;
GRANT SELECT, INSERT ON supplier_fulfillment_outcome TO gphkm_runtime;
CREATE POLICY supplier_fulfillment_outcome_assigned_read ON supplier_fulfillment_outcome FOR SELECT TO gphkm_runtime USING (
  public.gphkm_staff_can_read_order_item(order_item_id, nullif(current_setting('app.user_id',true),''))
);
CREATE POLICY supplier_fulfillment_outcome_assigned_insert ON supplier_fulfillment_outcome FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id',true),'')
  AND public.gphkm_staff_can_read_order_item(order_item_id, actor_user_id)
  AND EXISTS (SELECT 1 FROM public.order_item_fulfillment_supplier s WHERE s.order_item_id = supplier_fulfillment_outcome.order_item_id AND s.supplier_id = supplier_fulfillment_outcome.supplier_id)
  AND EXISTS (SELECT 1 FROM public.support_case c WHERE c.id = supplier_fulfillment_outcome.support_case_id AND c.order_item_id = supplier_fulfillment_outcome.order_item_id)
);
CREATE FUNCTION public.gphkm_reject_supplier_fulfillment_outcome_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'supplier outcome history is append-only' USING ERRCODE = '42501'; END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_supplier_fulfillment_outcome_mutation() FROM PUBLIC;
CREATE TRIGGER supplier_fulfillment_outcome_append_only BEFORE UPDATE OR DELETE ON supplier_fulfillment_outcome
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_supplier_fulfillment_outcome_mutation();

-- A supplier outcome may open a Support case on the customer's order. The customer
-- gets only a neutral update; supplier and internal evidence remain private.
CREATE POLICY support_case_supplier_outcome_open ON support_case FOR INSERT TO gphkm_runtime WITH CHECK (
  state = 'OPEN'
  AND opened_by_user_id = (SELECT o.actor_user_id FROM public.customer_order o WHERE o.id = support_case.order_id)
  AND public.gphkm_staff_can_read_order_item(order_item_id, nullif(current_setting('app.user_id',true),''))
);
ALTER TABLE support_case_event DROP CONSTRAINT support_case_event_shape;
ALTER TABLE support_case_event ADD CONSTRAINT support_case_event_shape CHECK (
  (kind = 'OPENED' AND audience = 'INTERNAL' AND actor_kind = 'CUSTOMER' AND from_state IS NULL AND to_state = 'OPEN' AND decision IS NULL)
  OR (kind = 'OPENED' AND audience = 'INTERNAL' AND actor_kind = 'STAFF' AND from_state IS NULL AND to_state = 'OPEN' AND decision IS NULL)
  OR (kind = 'REPLY' AND audience = 'CUSTOMER' AND from_state IS NULL AND to_state IS NULL AND decision IS NULL)
  OR (kind = 'NOTE' AND audience IN ('INTERNAL','FINANCE') AND actor_kind = 'STAFF' AND from_state IS NULL AND to_state IS NULL AND decision IS NULL)
  OR (kind = 'STATE_CHANGED' AND audience IN ('INTERNAL','FINANCE') AND actor_kind = 'STAFF' AND from_state IS NOT NULL AND to_state IS NOT NULL AND decision IS NULL)
  OR (kind = 'FINANCE_DECISION' AND audience = 'FINANCE' AND actor_kind = 'STAFF' AND from_state IS NULL AND to_state IS NULL AND decision IS NOT NULL)
);
DROP POLICY support_event_staff_insert ON support_case_event;
CREATE POLICY support_event_staff_insert ON support_case_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id',true),'') AND actor_kind = 'STAFF'
  AND (
    (public.gphkm_support_admin_access(case_id,actor_user_id) AND audience IN ('CUSTOMER','INTERNAL') AND kind IN ('OPENED','REPLY','NOTE','STATE_CHANGED'))
    OR (audience = 'FINANCE' AND kind IN ('NOTE','FINANCE_DECISION','STATE_CHANGED') AND (
      public.gphkm_support_finance_access(case_id,actor_user_id) OR public.gphkm_is_active_staff(actor_user_id,'SUPER_ADMIN')))
  )
);
CREATE OR REPLACE FUNCTION public.gphkm_support_event_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE case_row public.support_case%ROWTYPE; actor_id text := nullif(current_setting('app.user_id',true),'');
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'support history is append-only' USING ERRCODE = '23514'; END IF;
  SELECT * INTO case_row FROM public.support_case WHERE id = NEW.case_id FOR UPDATE;
  IF NOT FOUND OR case_row.state = 'CLOSED' THEN RAISE EXCEPTION 'support case is unavailable' USING ERRCODE = '23514'; END IF;
  IF NEW.kind = 'OPENED' AND (NEW.body <> case_row.summary
    OR EXISTS (SELECT 1 FROM public.support_case_event WHERE case_id = NEW.case_id AND kind = 'OPENED')
    OR (NEW.actor_kind = 'CUSTOMER' AND NEW.actor_user_id <> case_row.opened_by_user_id)
    OR (NEW.actor_kind = 'STAFF' AND (NEW.actor_user_id <> actor_id OR NOT public.gphkm_support_admin_access(case_row.id, actor_id)))) THEN
    RAISE EXCEPTION 'opening event mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'FINANCE_DECISION' AND case_row.state <> 'FINANCE_REVIEW' THEN
    RAISE EXCEPTION 'finance decision requires review' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Equivalent terms are snapshotted separately from confidential supplier routing.
ALTER TABLE order_item_content_change_request
  ADD COLUMN target_supplier_id text REFERENCES supplier(id);

CREATE TABLE order_item_equivalent_offer (
  id text PRIMARY KEY,
  order_item_id text NOT NULL REFERENCES customer_order_item(id),
  support_case_id text NOT NULL REFERENCES support_case(id),
  content_request_id text NOT NULL UNIQUE REFERENCES order_item_content_change_request(id),
  content_version_id text NOT NULL REFERENCES order_item_content_version(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  website_url text NOT NULL CHECK (website_url ~ '^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?/?$' AND website_url !~ '^https://([0-9]{1,3}\.){3}[0-9]{1,3}/?$'),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 4000),
  equivalence_note text NOT NULL CHECK (length(btrim(equivalence_note)) BETWEEN 5 AND 1000),
  categories text[] NOT NULL CHECK (cardinality(categories) BETWEEN 1 AND 7),
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  language text NOT NULL CHECK (length(language) BETWEEN 1 AND 80),
  link_type text NOT NULL CHECK (link_type IN ('DOFOLLOW','NOFOLLOW','SPONSORED','UGC')),
  link_validity text NOT NULL CHECK (link_validity IN ('PERMANENT','FIVE_YEARS','ONE_YEAR','SIX_MONTHS','THREE_MONTHS')),
  turnaround_days integer NOT NULL CHECK (turnaround_days BETWEEN 1 AND 365),
  buyer_requirements text CHECK (buyer_requirements IS NULL OR length(buyer_requirements) <= 4000),
  sponsored_content_marking boolean NOT NULL,
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
  locked_price_minor numeric(20,0) NOT NULL CHECK (locked_price_minor > 0),
  offered_by_user_id text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_item_equivalent_offer_item_idx ON order_item_equivalent_offer(order_item_id, created_at);
ALTER TABLE order_item_equivalent_offer ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON order_item_equivalent_offer FROM PUBLIC, gphkm_runtime;
GRANT SELECT, INSERT ON order_item_equivalent_offer TO gphkm_runtime;
CREATE POLICY equivalent_offer_customer_read ON order_item_equivalent_offer FOR SELECT TO gphkm_runtime USING (
  public.gphkm_customer_can_read_order_item(order_item_id,
    nullif(current_setting('app.user_id',true),''), nullif(current_setting('app.organization_id',true),''))
);
CREATE POLICY equivalent_offer_staff_read ON order_item_equivalent_offer FOR SELECT TO gphkm_runtime USING (
  public.gphkm_staff_can_read_order_item(order_item_id, nullif(current_setting('app.user_id',true),''))
);
CREATE POLICY equivalent_offer_staff_insert ON order_item_equivalent_offer FOR INSERT TO gphkm_runtime WITH CHECK (
  offered_by_user_id = nullif(current_setting('app.user_id',true),'')
  AND public.gphkm_staff_can_read_order_item(order_item_id, offered_by_user_id)
  AND EXISTS (SELECT 1 FROM public.support_case c WHERE c.id = order_item_equivalent_offer.support_case_id AND c.order_item_id = order_item_equivalent_offer.order_item_id AND c.state NOT IN ('RESOLVED','CLOSED'))
  AND EXISTS (SELECT 1 FROM public.customer_order_item i WHERE i.id = order_item_equivalent_offer.order_item_id AND i.placement_price_minor + i.writing_price_minor = order_item_equivalent_offer.locked_price_minor)
  AND EXISTS (SELECT 1 FROM public.order_item_content_change_request r WHERE r.id = order_item_equivalent_offer.content_request_id AND r.order_item_id = order_item_equivalent_offer.order_item_id AND r.target_supplier_id IS NOT NULL)
);
CREATE FUNCTION public.gphkm_reject_equivalent_offer_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'equivalent offer terms are append-only' USING ERRCODE = '42501'; END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_equivalent_offer_mutation() FROM PUBLIC;
CREATE TRIGGER equivalent_offer_append_only BEFORE UPDATE OR DELETE ON order_item_equivalent_offer
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_equivalent_offer_mutation();

CREATE TABLE order_item_equivalent_offer_route (
  offer_id text PRIMARY KEY REFERENCES order_item_equivalent_offer(id),
  supplier_id text NOT NULL REFERENCES supplier(id),
  recipient_email text NOT NULL CHECK (length(recipient_email) BETWEEN 3 AND 320),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE order_item_equivalent_offer_route ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON order_item_equivalent_offer_route FROM PUBLIC, gphkm_runtime;
GRANT SELECT, INSERT ON order_item_equivalent_offer_route TO gphkm_runtime;
CREATE POLICY equivalent_offer_route_assigned_read ON order_item_equivalent_offer_route FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM public.order_item_equivalent_offer o WHERE o.id = offer_id
    AND public.gphkm_staff_can_read_order_item(o.order_item_id, nullif(current_setting('app.user_id',true),'')))
);
CREATE POLICY equivalent_offer_route_assigned_insert ON order_item_equivalent_offer_route FOR INSERT TO gphkm_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM public.order_item_equivalent_offer o WHERE o.id = offer_id
    AND o.offered_by_user_id = nullif(current_setting('app.user_id',true),'')
    AND public.gphkm_staff_can_read_order_item(o.order_item_id, o.offered_by_user_id))
  AND EXISTS (SELECT 1 FROM public.order_item_content_version v
    JOIN public.order_item_equivalent_offer o ON o.content_version_id = v.id
    WHERE o.id = order_item_equivalent_offer_route.offer_id AND v.supplier_id = order_item_equivalent_offer_route.supplier_id AND v.content_hash = order_item_equivalent_offer_route.content_hash AND lower(v.recipient_email) = lower(order_item_equivalent_offer_route.recipient_email))
  AND EXISTS (SELECT 1 FROM public.supplier_contact c WHERE c.supplier_id = order_item_equivalent_offer_route.supplier_id AND c.is_primary AND lower(c.email) = lower(order_item_equivalent_offer_route.recipient_email))
);
CREATE TRIGGER equivalent_offer_route_append_only BEFORE UPDATE OR DELETE ON order_item_equivalent_offer_route
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_equivalent_offer_mutation();

CREATE TABLE order_item_equivalent_offer_event (
  id text PRIMARY KEY,
  offer_id text NOT NULL REFERENCES order_item_equivalent_offer(id),
  actor_user_id text NOT NULL REFERENCES auth_user(id),
  event_type text NOT NULL CHECK (event_type IN ('OFFERED','ACCEPTED','DECLINED')),
  content_hash text,
  notice_version text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((event_type = 'OFFERED' AND content_hash ~ '^[0-9a-f]{64}$' AND notice_version IS NULL AND reason IS NULL)
    OR (event_type = 'ACCEPTED' AND content_hash ~ '^[0-9a-f]{64}$' AND length(notice_version) BETWEEN 1 AND 80 AND reason IS NULL)
    OR (event_type = 'DECLINED' AND content_hash IS NULL AND notice_version IS NULL AND length(reason) BETWEEN 1 AND 1000))
);
CREATE INDEX order_item_equivalent_offer_event_idx ON order_item_equivalent_offer_event(offer_id, created_at);
ALTER TABLE order_item_equivalent_offer_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON order_item_equivalent_offer_event FROM PUBLIC, gphkm_runtime;
GRANT SELECT, INSERT ON order_item_equivalent_offer_event TO gphkm_runtime;
CREATE POLICY equivalent_offer_event_customer_read ON order_item_equivalent_offer_event FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM public.order_item_equivalent_offer o WHERE o.id = offer_id
    AND public.gphkm_customer_can_read_order_item(o.order_item_id,
      nullif(current_setting('app.user_id',true),''), nullif(current_setting('app.organization_id',true),'')))
);
CREATE POLICY equivalent_offer_event_staff_read ON order_item_equivalent_offer_event FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM public.order_item_equivalent_offer o WHERE o.id = offer_id
    AND public.gphkm_staff_can_read_order_item(o.order_item_id, nullif(current_setting('app.user_id',true),'')))
);
CREATE POLICY equivalent_offer_event_staff_insert ON order_item_equivalent_offer_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id',true),'') AND event_type IN ('OFFERED')
  AND EXISTS (SELECT 1 FROM public.order_item_equivalent_offer o WHERE o.id = offer_id AND o.offered_by_user_id = actor_user_id
    AND public.gphkm_staff_can_read_order_item(o.order_item_id, actor_user_id))
);
CREATE POLICY equivalent_offer_event_customer_insert ON order_item_equivalent_offer_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id',true),'') AND event_type IN ('ACCEPTED','DECLINED')
  AND EXISTS (SELECT 1 FROM public.order_item_equivalent_offer o
    JOIN public.customer_order_item i ON i.id = o.order_item_id JOIN public.customer_order ord ON ord.id = i.order_id
    WHERE o.id = offer_id AND ord.organization_id = nullif(current_setting('app.organization_id',true),'')
      AND ord.actor_user_id = actor_user_id AND public.gphkm_is_active_org_member(ord.organization_id, actor_user_id))
);
CREATE FUNCTION public.gphkm_reject_equivalent_offer_event_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE offer_order_item text; offer_state text;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'equivalent offer history is append-only' USING ERRCODE = '42501'; END IF;
  -- Serialize competing OFFERED/ACCEPTED/DECLINED writes even if a future
  -- caller bypasses the current application command's order-item lock.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.offer_id, 0));
  SELECT order_item_id INTO offer_order_item FROM public.order_item_equivalent_offer WHERE id = NEW.offer_id;
  IF offer_order_item IS NULL OR NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_route r WHERE r.offer_id = NEW.offer_id) THEN
    RAISE EXCEPTION 'equivalent offer route is unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT event_type INTO offer_state FROM public.order_item_equivalent_offer_event WHERE offer_id = NEW.offer_id ORDER BY created_at DESC, id DESC LIMIT 1;
  IF NEW.event_type = 'OFFERED' THEN
    IF offer_state IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer o
      JOIN public.order_item_content_version v ON v.id = o.content_version_id
      JOIN public.order_item_equivalent_offer_route r ON r.offer_id = o.id
      WHERE o.id = NEW.offer_id AND NEW.content_hash = v.content_hash AND NEW.content_hash = r.content_hash) THEN
      RAISE EXCEPTION 'equivalent offer opening is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF offer_state IS DISTINCT FROM 'OFFERED' THEN
    RAISE EXCEPTION 'equivalent offer already resolved' USING ERRCODE = '23514';
  ELSIF NEW.event_type = 'ACCEPTED' THEN
    IF NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_route r WHERE r.offer_id = NEW.offer_id AND r.content_hash = NEW.content_hash)
      OR NEW.notice_version IS NULL THEN RAISE EXCEPTION 'equivalent offer consent mismatch' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_equivalent_offer_event_mutation() FROM PUBLIC;
CREATE TRIGGER equivalent_offer_event_append_only BEFORE INSERT OR UPDATE OR DELETE ON order_item_equivalent_offer_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_equivalent_offer_event_mutation();

-- Acceptance changes only internal fulfillment routing. The customer event and
-- matching content consent are written by the scoped application command first.
CREATE FUNCTION public.gphkm_apply_equivalent_offer_acceptance(target_offer_id text, target_user_id text, target_org_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE item_id text; next_supplier text; next_recipient text; request_id text; version_id text; content_digest text;
BEGIN
  IF target_user_id IS NULL OR target_user_id <> nullif(current_setting('app.user_id',true),'')
    OR target_org_id <> nullif(current_setting('app.organization_id',true),'') THEN
    RAISE EXCEPTION 'equivalent offer unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT o.order_item_id, r.supplier_id, r.recipient_email, o.content_request_id, o.content_version_id, r.content_hash
    INTO item_id, next_supplier, next_recipient, request_id, version_id, content_digest
    FROM public.order_item_equivalent_offer o JOIN public.order_item_equivalent_offer_route r ON r.offer_id = o.id
    JOIN public.customer_order_item i ON i.id = o.order_item_id JOIN public.customer_order ord ON ord.id = i.order_id
    WHERE o.id = target_offer_id AND ord.organization_id = target_org_id AND ord.actor_user_id = target_user_id
      AND public.gphkm_is_active_org_member(target_org_id, target_user_id)
      AND EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_event e WHERE e.offer_id = o.id AND e.event_type = 'ACCEPTED' AND e.actor_user_id = target_user_id AND e.content_hash = r.content_hash)
      AND NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_event e WHERE e.offer_id = o.id AND e.event_type = 'DECLINED');
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.order_item_content_change_event e WHERE e.request_id = request_id AND e.event_type = 'CONSENTED' AND e.version_id = version_id AND e.content_hash = content_digest AND e.actor_user_id = target_user_id)
    OR NOT EXISTS (SELECT 1 FROM public.supplier_contact c WHERE c.supplier_id = next_supplier AND c.is_primary AND lower(c.email) = lower(next_recipient))
    OR NOT EXISTS (SELECT 1 FROM public.order_item_fulfillment f WHERE f.order_item_id = item_id AND f.state NOT IN ('COMPLETED','CANCELED_REFUNDED')) THEN
    RAISE EXCEPTION 'equivalent offer consent or route is unavailable' USING ERRCODE = '42501';
  END IF;
  UPDATE public.order_item_fulfillment_supplier SET supplier_id = next_supplier WHERE order_item_id = item_id;
  UPDATE public.order_item_fulfillment SET state = 'READY_FOR_HANDOFF', state_before_hold = NULL,
    customer_status = 'PREPARING', updated_at = clock_timestamp() WHERE order_item_id = item_id;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_apply_equivalent_offer_acceptance(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_apply_equivalent_offer_acceptance(text,text,text) TO gphkm_runtime;

-- Equivalent offers can version the unchanged order content for a new supplier
-- after a failure. Only assigned staff may make that special request/version.
CREATE POLICY content_change_request_equivalent_insert ON order_item_content_change_request FOR INSERT TO gphkm_runtime WITH CHECK (
  target_supplier_id IS NOT NULL
  AND public.gphkm_staff_can_read_order_item(order_item_id, nullif(current_setting('app.user_id',true),''))
  AND requested_by_user_id = (SELECT o.actor_user_id FROM public.customer_order_item i JOIN public.customer_order o ON o.id = i.order_id WHERE i.id = order_item_id)
  AND EXISTS (SELECT 1 FROM public.support_case c WHERE c.order_item_id = order_item_id AND c.state NOT IN ('RESOLVED','CLOSED'))
  AND EXISTS (SELECT 1 FROM public.supplier s JOIN public.supplier_contact sc ON sc.supplier_id = s.id WHERE s.id = target_supplier_id AND s.status = 'ACTIVE' AND sc.is_primary)
);
CREATE POLICY content_version_equivalent_insert ON order_item_content_version FOR INSERT TO gphkm_runtime WITH CHECK (
  approved_by_user_id = nullif(current_setting('app.user_id',true),'')
  AND public.gphkm_staff_can_read_order_item(order_item_id, approved_by_user_id)
  AND EXISTS (SELECT 1 FROM public.order_item_content_change_request r WHERE r.id = request_id AND r.order_item_id = order_item_id AND r.target_supplier_id = supplier_id)
  AND EXISTS (SELECT 1 FROM public.support_case c WHERE c.order_item_id = order_item_id AND c.state NOT IN ('RESOLVED','CLOSED'))
);
CREATE OR REPLACE FUNCTION public.gphkm_validate_content_change_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE fulfillment_row public.order_item_fulfillment%ROWTYPE; actor_id text := nullif(current_setting('app.user_id',true),'');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.customer_order_item oi WHERE oi.id = NEW.order_item_id) THEN RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment f WHERE f.order_item_id = NEW.order_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '23514'; END IF;
  IF NEW.target_supplier_id IS NULL THEN
    IF fulfillment_row.handed_off_at IS NOT NULL OR fulfillment_row.state IN ('IN_FULFILLMENT','PUBLICATION_PENDING','EVIDENCE_REVIEW','COMPLETED','CANCELED_REFUNDED') THEN
      RAISE EXCEPTION 'content changes close after handoff' USING ERRCODE = '23514';
    END IF;
  ELSIF fulfillment_row.state IN ('COMPLETED','CANCELED_REFUNDED')
    OR NOT public.gphkm_staff_can_read_order_item(NEW.order_item_id, actor_id)
    OR NOT EXISTS (SELECT 1 FROM public.support_case c WHERE c.order_item_id = NEW.order_item_id AND c.state NOT IN ('RESOLVED','CLOSED'))
    OR NOT EXISTS (SELECT 1 FROM public.supplier s JOIN public.supplier_contact sc ON sc.supplier_id = s.id WHERE s.id = NEW.target_supplier_id AND s.status = 'ACTIVE' AND sc.is_primary) THEN
    RAISE EXCEPTION 'equivalent content route is unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.gphkm_validate_content_change_event_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE version_row public.order_item_content_version%ROWTYPE; request_row public.order_item_content_change_request%ROWTYPE;
BEGIN
  IF NEW.event_type IN ('APPROVED','CONSENTED') THEN
    IF NEW.version_id IS NULL THEN RAISE EXCEPTION 'approved content event requires a version' USING ERRCODE = '23514'; END IF;
    SELECT * INTO version_row FROM public.order_item_content_version v WHERE v.id = NEW.version_id AND v.request_id = NEW.request_id;
    SELECT * INTO request_row FROM public.order_item_content_change_request r WHERE r.id = NEW.request_id;
    IF NOT FOUND OR version_row.id IS NULL OR NEW.content_hash IS DISTINCT FROM version_row.content_hash THEN
      RAISE EXCEPTION 'event hash does not match bound content, supplier and recipient' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.event_type = 'CONSENTED' AND NOT public.gphkm_change_request_before_handoff(request_row.order_item_id)
    AND (request_row.target_supplier_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer o
      JOIN public.order_item_equivalent_offer_event e ON e.offer_id = o.id
      WHERE o.content_request_id = request_row.id AND e.event_type = 'ACCEPTED' AND e.content_hash = version_row.content_hash AND e.actor_user_id = NEW.actor_user_id)) THEN
    RAISE EXCEPTION 'content consent closes after handoff unless linked to an accepted equivalent offer' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.gphkm_customer_equivalent_offer_consent_data(target_offer_id text, target_user_id text, target_org_id text)
RETURNS TABLE(supplier_id text, recipient_email text, content_hash text, request_id text, version_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT route.supplier_id, route.recipient_email, route.content_hash, offer.content_request_id, offer.content_version_id
  FROM public.order_item_equivalent_offer offer
  JOIN public.order_item_equivalent_offer_route route ON route.offer_id = offer.id
  JOIN public.customer_order_item item ON item.id = offer.order_item_id
  JOIN public.customer_order ord ON ord.id = item.order_id
  JOIN public.supplier_contact contact ON contact.supplier_id = route.supplier_id AND contact.is_primary
  WHERE offer.id = target_offer_id AND ord.organization_id = target_org_id AND ord.actor_user_id = target_user_id
    AND target_user_id = nullif(current_setting('app.user_id',true),'')
    AND target_org_id = nullif(current_setting('app.organization_id',true),'')
    AND public.gphkm_is_active_org_member(target_org_id, target_user_id)
    AND lower(contact.email) = lower(route.recipient_email)
    AND EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_event event WHERE event.offer_id = offer.id AND event.event_type = 'OFFERED')
    AND NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_event event WHERE event.offer_id = offer.id AND event.event_type IN ('ACCEPTED','DECLINED'))
$$;
REVOKE ALL ON FUNCTION public.gphkm_customer_equivalent_offer_consent_data(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_customer_equivalent_offer_consent_data(text,text,text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_lock_equivalent_offer_item(target_offer_id text, target_user_id text, target_org_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE item_ref text; orderer text;
BEGIN
  IF target_user_id IS NULL OR target_user_id <> nullif(current_setting('app.user_id',true),'')
    OR target_org_id <> nullif(current_setting('app.organization_id',true),'') THEN
    RAISE EXCEPTION 'equivalent offer unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT offer.order_item_id, ord.actor_user_id INTO item_ref, orderer
    FROM public.order_item_equivalent_offer offer
    JOIN public.customer_order_item item ON item.id = offer.order_item_id
    JOIN public.customer_order ord ON ord.id = item.order_id
    WHERE offer.id = target_offer_id AND ord.organization_id = target_org_id;
  IF NOT FOUND OR orderer <> target_user_id OR NOT public.gphkm_is_active_org_member(target_org_id,target_user_id) THEN
    RAISE EXCEPTION 'equivalent offer unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.order_item_fulfillment WHERE order_item_id = item_ref FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'equivalent offer unavailable' USING ERRCODE = '42501'; END IF;
  RETURN item_ref;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_lock_equivalent_offer_item(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_lock_equivalent_offer_item(text,text,text) TO gphkm_runtime;

-- Do not allow an item with an unresolved supplier-failure case to proceed to
-- handoff/work-start. Acceptance or an item-only cancellation/refund resolves it.
CREATE FUNCTION public.gphkm_gate_unresolved_supplier_failure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.supplier_fulfillment_outcome outcome
    JOIN public.support_case c ON c.id = outcome.support_case_id
    WHERE outcome.order_item_id = NEW.order_item_id
      AND NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer offer
        JOIN public.order_item_equivalent_offer_event event ON event.offer_id = offer.id
        WHERE offer.support_case_id = c.id AND event.event_type = 'ACCEPTED')
  ) AND NEW.state NOT IN ('ON_HOLD','CANCELLATION_REQUESTED','CANCELED_REFUNDED')
    AND NOT (OLD.state = 'ON_HOLD' AND NEW.state = OLD.state_before_hold AND OLD.state_before_hold IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome JOIN public.support_case c ON c.id = outcome.support_case_id
        JOIN public.order_item_equivalent_offer offer ON offer.support_case_id = c.id
        JOIN public.order_item_equivalent_offer_event event ON event.offer_id = offer.id
        WHERE outcome.order_item_id = NEW.order_item_id AND event.event_type = 'DECLINED')) THEN
    RAISE EXCEPTION 'resolve supplier failure through customer-approved equivalent or item cancellation before handoff' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_gate_unresolved_supplier_failure() FROM PUBLIC;
CREATE TRIGGER fulfillment_supplier_failure_gate BEFORE UPDATE OF state, handed_off_at, work_started_at
  ON order_item_fulfillment FOR EACH ROW EXECUTE FUNCTION public.gphkm_gate_unresolved_supplier_failure();

CREATE FUNCTION public.gphkm_equivalent_offer_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_id text; customer_id text; title_value text; body_value text; case_ref text;
BEGIN
  SELECT ord.organization_id, ord.actor_user_id, offer.support_case_id
    INTO org_id, customer_id, case_ref
    FROM public.order_item_equivalent_offer offer
    JOIN public.customer_order_item item ON item.id = offer.order_item_id
    JOIN public.customer_order ord ON ord.id = item.order_id WHERE offer.id = NEW.offer_id;
  IF org_id IS NULL OR customer_id IS NULL THEN RETURN NEW; END IF;
  CASE NEW.event_type
    WHEN 'OFFERED' THEN title_value := 'Placement option ready'; body_value := 'GPHKM has an alternative placement for your review. Its price matches your order.';
    WHEN 'ACCEPTED' THEN title_value := 'Placement option accepted'; body_value := 'GPHKM recorded your approval and is preparing your placement.';
    WHEN 'DECLINED' THEN title_value := 'Placement option declined'; body_value := 'GPHKM recorded your decision. Review the Support request for next steps.';
    ELSE RETURN NEW;
  END CASE;
  PERFORM public.gphkm_enqueue_customer_notification(org_id, customer_id, 'SUPPORT_UPDATE', title_value, body_value,
    NULL, case_ref, 'equivalent-offer:' || NEW.offer_id || ':' || NEW.event_type);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_equivalent_offer_notification() FROM PUBLIC;
CREATE TRIGGER equivalent_offer_notification AFTER INSERT ON order_item_equivalent_offer_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_equivalent_offer_notification();

-- Declining an equivalent clears the content-consent hold for ordinary pre-handoff
-- cancellation, while the supplier-failure gate still prevents fulfillment restart.
CREATE OR REPLACE FUNCTION public.gphkm_customer_can_request_item_cancellation(target_item_id text, target_user_id text, target_org_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_customer_can_read_order_item(target_item_id, target_user_id, target_org_id)
    AND EXISTS (
      SELECT 1 FROM public.customer_order_item i JOIN public.customer_order o ON o.id = i.order_id
      JOIN public.order_item_fulfillment f ON f.order_item_id = i.id
      WHERE i.id = target_item_id AND o.organization_id = target_org_id AND o.checkout_state = 'PAID'
        AND f.state IN ('CONFIRMED','CONTENT_PREPARATION','AWAITING_CUSTOMER_APPROVAL','READY_FOR_HANDOFF','HANDOFF_PENDING')
        AND f.handed_off_at IS NULL AND f.work_started_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.supplier_packet_item pi JOIN public.supplier_packet_attempt a ON a.packet_id = pi.packet_id
      WHERE pi.order_item_id = target_item_id AND a.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERED','DELIVERY_ISSUE','MANUAL_SENT')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.order_item_content_change_request r
      JOIN LATERAL (SELECT e.event_type FROM public.order_item_content_change_event e
        WHERE e.request_id = r.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) latest ON true
      WHERE r.order_item_id = target_item_id AND latest.event_type IN ('REQUESTED','APPROVED')
        AND NOT (r.target_supplier_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.order_item_equivalent_offer offer
          JOIN public.order_item_equivalent_offer_event event ON event.offer_id = offer.id
          WHERE offer.content_request_id = r.id AND event.event_type = 'DECLINED'))
    )
$$;
CREATE OR REPLACE FUNCTION public.gphkm_reject_cancellation_with_pending_content_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.state = 'CANCELLATION_REQUESTED' AND OLD.state IS DISTINCT FROM NEW.state AND EXISTS (
    SELECT 1 FROM public.order_item_content_change_request r
    JOIN LATERAL (SELECT e.event_type FROM public.order_item_content_change_event e
      WHERE e.request_id = r.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) latest ON true
    WHERE r.order_item_id = NEW.order_item_id AND latest.event_type IN ('REQUESTED','APPROVED')
      AND NOT (r.target_supplier_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.order_item_equivalent_offer offer
        JOIN public.order_item_equivalent_offer_event event ON event.offer_id = offer.id
        WHERE offer.content_request_id = r.id AND event.event_type = 'DECLINED'))
  ) THEN
    RAISE EXCEPTION 'resolve the pending content change before requesting cancellation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
