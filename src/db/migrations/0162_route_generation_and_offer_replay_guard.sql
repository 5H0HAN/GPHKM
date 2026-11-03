-- A route change invalidates every packet made for an older supplier route.
-- Legacy rows start at generation 1, which preserves the meaning of existing
-- packet snapshots while making later A -> B -> A transitions distinguishable.
ALTER TABLE public.order_item_fulfillment_supplier
  ADD COLUMN route_generation integer NOT NULL DEFAULT 1,
  ADD COLUMN last_equivalent_offer_id text,
  ADD CONSTRAINT order_item_fulfillment_supplier_generation_positive CHECK (route_generation > 0);

ALTER TABLE public.supplier_packet_item
  ADD COLUMN route_generation integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT supplier_packet_item_route_generation_positive CHECK (route_generation > 0);

ALTER TABLE public.order_item_equivalent_offer_route
  ADD COLUMN route_generation integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT order_item_equivalent_offer_route_generation_positive CHECK (route_generation > 0);

-- Existing packet/route rows remain generation 1. Preserve the currently
-- applied accepted offer pointer when the accepted target is the live route.
UPDATE public.order_item_fulfillment_supplier fs
   SET last_equivalent_offer_id = (
    SELECT offer.id FROM public.order_item_equivalent_offer offer
    JOIN public.order_item_equivalent_offer_route route ON route.offer_id = offer.id
    JOIN public.order_item_equivalent_offer_event event ON event.offer_id = offer.id
    WHERE offer.order_item_id = fs.order_item_id AND route.supplier_id = fs.supplier_id
      AND event.event_type = 'ACCEPTED'
    ORDER BY event.created_at DESC, event.id DESC LIMIT 1
  )
 WHERE EXISTS (SELECT 1 FROM public.order_item_equivalent_offer offer
    JOIN public.order_item_equivalent_offer_route route ON route.offer_id = offer.id
    JOIN public.order_item_equivalent_offer_event event ON event.offer_id = offer.id
    WHERE offer.order_item_id = fs.order_item_id AND route.supplier_id = fs.supplier_id AND event.event_type = 'ACCEPTED');

-- An existing pending offer was created for the currently selected route.
-- Snapshot the generation it expects before installing the stricter trigger.
ALTER TABLE public.order_item_equivalent_offer_route
  DISABLE TRIGGER equivalent_offer_route_append_only;
UPDATE public.order_item_equivalent_offer_route route
   SET route_generation = fs.route_generation + 1
  FROM public.order_item_equivalent_offer offer
  JOIN public.order_item_fulfillment_supplier fs ON fs.order_item_id = offer.order_item_id
 WHERE route.offer_id = offer.id AND (SELECT event.event_type
   FROM public.order_item_equivalent_offer_event event WHERE event.offer_id = offer.id
   ORDER BY event.created_at DESC, event.id DESC LIMIT 1) = 'OFFERED';
ALTER TABLE public.order_item_equivalent_offer_route
  ENABLE TRIGGER equivalent_offer_route_append_only;

CREATE INDEX supplier_packet_item_route_generation_idx
  ON public.supplier_packet_item(order_item_id, route_generation);

-- Packet membership can only capture the route version that is current while
-- the fulfillment item is locked. The route row is always locked second.
CREATE OR REPLACE FUNCTION public.gphkm_packet_item_route_generation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE item_state text; route_supplier_id text; route_generation_value integer;
  packet_supplier_id text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'packet item route snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  SELECT f.state INTO item_state FROM public.order_item_fulfillment f
    WHERE f.order_item_id = NEW.order_item_id FOR UPDATE;
  SELECT fs.supplier_id, fs.route_generation INTO route_supplier_id, route_generation_value
    FROM public.order_item_fulfillment_supplier fs
    WHERE fs.order_item_id = NEW.order_item_id FOR KEY SHARE;
  SELECT p.supplier_id INTO packet_supplier_id FROM public.supplier_packet p WHERE p.id = NEW.packet_id;
  IF item_state IS NULL OR route_generation_value IS NULL OR packet_supplier_id IS NULL
    OR NEW.route_generation <> route_generation_value
    OR route_supplier_id IS DISTINCT FROM packet_supplier_id THEN
    RAISE EXCEPTION 'packet item route generation is stale' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_packet_item_route_generation_guard() FROM PUBLIC;
CREATE TRIGGER supplier_packet_item_route_generation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.supplier_packet_item
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_packet_item_route_generation_guard();

-- Reserve every send/export/manual handoff only while the packet's full set of
-- item and route locks still match. Sorted item order avoids batch deadlocks.
CREATE OR REPLACE FUNCTION public.gphkm_packet_attempt_route_generation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE packet_row public.supplier_packet%ROWTYPE; item_ref text; item_route_supplier_id text; item_route_generation integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.type NOT IN ('SEND','EML_EXPORT','PDF_EXPORT','MANUAL_SENT','MANUAL_SEND') THEN RETURN NEW; END IF;
  SELECT p.* INTO packet_row FROM public.supplier_packet p WHERE p.id = NEW.packet_id FOR UPDATE;
  IF NOT FOUND OR packet_row.superseded_at IS NOT NULL OR packet_row.hold_reason IS NOT NULL THEN
    RAISE EXCEPTION 'supplier packet is superseded, held, or unavailable' USING ERRCODE = '42501';
  END IF;

  FOR item_ref IN
    SELECT pi.order_item_id FROM public.supplier_packet_item pi
     WHERE pi.packet_id = NEW.packet_id ORDER BY pi.order_item_id
  LOOP
    PERFORM 1 FROM public.order_item_fulfillment f
      WHERE f.order_item_id = item_ref FOR UPDATE;
    SELECT fs.supplier_id, fs.route_generation INTO item_route_supplier_id, item_route_generation
      FROM public.order_item_fulfillment_supplier fs
      WHERE fs.order_item_id = item_ref FOR KEY SHARE;
    IF item_route_supplier_id IS DISTINCT FROM packet_row.supplier_id OR NOT EXISTS (
      SELECT 1 FROM public.supplier_packet_item pi
      JOIN public.supplier_packet packet ON packet.id = pi.packet_id
      JOIN public.supplier_contact contact ON contact.supplier_id = packet.supplier_id AND contact.is_primary
       WHERE pi.packet_id = NEW.packet_id AND pi.order_item_id = item_ref
         AND pi.route_generation = item_route_generation
         AND packet.version = (SELECT max(latest.version)
           FROM public.supplier_packet latest
           JOIN public.supplier_packet_item latest_item ON latest_item.packet_id = latest.id
           WHERE latest_item.order_item_id = item_ref AND latest_item.route_generation = item_route_generation
             AND latest.supplier_id = item_route_supplier_id AND latest.superseded_at IS NULL AND latest.hold_reason IS NULL)
         AND lower(contact.email) = lower(packet.recipient)
    ) THEN
      RAISE EXCEPTION 'supplier packet route, recipient, or active version is stale' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome
      WHERE outcome.order_item_id = item_ref
        AND NOT EXISTS (
          SELECT 1 FROM public.order_item_equivalent_offer offer
          JOIN public.order_item_equivalent_offer_route offer_route ON offer_route.offer_id = offer.id
          JOIN LATERAL (SELECT e.event_type, e.actor_user_id FROM public.order_item_equivalent_offer_event e
            WHERE e.offer_id = offer.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) latest ON true
          WHERE offer.order_item_id = outcome.order_item_id AND offer.support_case_id = outcome.support_case_id
            AND latest.event_type = 'ACCEPTED' AND offer_route.route_generation <= item_route_generation
        )) THEN
      RAISE EXCEPTION 'resolve the current supplier failure before sending or exporting a packet' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.supplier_packet_item pi WHERE pi.packet_id = NEW.packet_id) THEN
    RAISE EXCEPTION 'supplier packet has no items' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_packet_attempt_route_generation_guard() FROM PUBLIC;
CREATE TRIGGER supplier_packet_attempt_route_generation_guard
  BEFORE INSERT ON public.supplier_packet_attempt
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_packet_attempt_route_generation_guard();

-- Event timestamps are made monotonic per item by the database. This keeps
-- latest-offer checks deterministic even when clients submit old timestamps.
CREATE OR REPLACE FUNCTION public.gphkm_reject_equivalent_offer_event_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE offer_item_id text; offer_state text; current_supplier_id text; target_supplier_id text;
  current_generation integer; target_generation integer;
  support_case_ref text; last_item_event timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'equivalent offer history is append-only' USING ERRCODE = '42501';
  END IF;
  SELECT o.order_item_id, o.support_case_id, r.supplier_id, r.route_generation
    INTO offer_item_id, support_case_ref, target_supplier_id, target_generation
    FROM public.order_item_equivalent_offer o
    JOIN public.order_item_equivalent_offer_route r ON r.offer_id = o.id
   WHERE o.id = NEW.offer_id;
  IF offer_item_id IS NULL THEN RAISE EXCEPTION 'equivalent offer route is unavailable' USING ERRCODE = '23514'; END IF;

  -- The shared item lock serializes competing offer events and acceptance.
  PERFORM 1 FROM public.order_item_fulfillment f WHERE f.order_item_id = offer_item_id FOR UPDATE;
  SELECT fs.supplier_id, fs.route_generation INTO current_supplier_id, current_generation FROM public.order_item_fulfillment_supplier fs
    WHERE fs.order_item_id = offer_item_id FOR KEY SHARE;
  IF current_supplier_id IS NULL OR current_supplier_id = target_supplier_id OR target_generation <> current_generation + 1 THEN
    RAISE EXCEPTION 'equivalent offer route is no longer current' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(offer_item_id, 0));

  SELECT e.event_type INTO offer_state FROM public.order_item_equivalent_offer_event e
    WHERE e.offer_id = NEW.offer_id ORDER BY e.created_at DESC, e.id DESC LIMIT 1;
  IF NEW.event_type NOT IN ('OFFERED','ACCEPTED','DECLINED') THEN
    RAISE EXCEPTION 'equivalent offer event is invalid' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.support_case c
    JOIN public.supplier_fulfillment_outcome outcome ON outcome.support_case_id = c.id
    WHERE c.id = support_case_ref AND c.order_item_id = offer_item_id
      AND c.state NOT IN ('RESOLVED','CLOSED')
      AND outcome.order_item_id = offer_item_id AND outcome.supplier_id = current_supplier_id
  ) THEN
    RAISE EXCEPTION 'equivalent offer requires an active case and current supplier failure outcome' USING ERRCODE = '42501';
  END IF;

  IF NEW.event_type = 'OFFERED' THEN
    IF offer_state IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer o
      JOIN public.order_item_content_version v ON v.id = o.content_version_id
      JOIN public.order_item_equivalent_offer_route r ON r.offer_id = o.id
      WHERE o.id = NEW.offer_id AND NEW.content_hash = v.content_hash AND NEW.content_hash = r.content_hash)
      OR EXISTS (
        SELECT 1 FROM (
          SELECT DISTINCT ON (e.offer_id) e.offer_id, e.event_type
            FROM public.order_item_equivalent_offer_event e
            JOIN public.order_item_equivalent_offer existing ON existing.id = e.offer_id
           WHERE existing.order_item_id = offer_item_id
           ORDER BY e.offer_id, e.created_at DESC, e.id DESC
        ) latest WHERE latest.event_type = 'OFFERED'
      ) THEN
      RAISE EXCEPTION 'equivalent offer opening is invalid or another offer is unresolved' USING ERRCODE = '23514';
    END IF;
  ELSIF offer_state IS DISTINCT FROM 'OFFERED' THEN
    RAISE EXCEPTION 'equivalent offer already resolved' USING ERRCODE = '23514';
  ELSIF NEW.event_type = 'ACCEPTED' THEN
    IF NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_route r
      WHERE r.offer_id = NEW.offer_id AND r.content_hash = NEW.content_hash)
      OR NEW.notice_version IS NULL THEN
      RAISE EXCEPTION 'equivalent offer consent mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT max(e.created_at) INTO last_item_event FROM public.order_item_equivalent_offer_event e
    JOIN public.order_item_equivalent_offer o ON o.id = e.offer_id WHERE o.order_item_id = offer_item_id;
  NEW.created_at := greatest(coalesce(NEW.created_at, clock_timestamp()),
    coalesce(last_item_event + interval '1 microsecond', clock_timestamp()));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_equivalent_offer_event_mutation() FROM PUBLIC;

-- Acceptance is safe when invoked directly by gphkm_runtime: item then route
-- locks, exact current offer and consent revalidation, and no unresolved send.
CREATE OR REPLACE FUNCTION public.gphkm_apply_equivalent_offer_acceptance(target_offer_id text, target_user_id text, target_org_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_item_id text; v_next_supplier text; v_next_recipient text; v_request_id text; v_version_id text;
  v_content_digest text; v_case_id text; v_current_supplier text; v_last_offer text;
  v_route_generation integer; v_target_generation integer; v_latest_accepted_at timestamptz; v_offer_accepted_at timestamptz;
  v_fulfillment public.order_item_fulfillment%ROWTYPE; v_recovery boolean;
BEGIN
  IF target_user_id IS NULL OR target_user_id <> nullif(current_setting('app.user_id',true),'')
    OR target_org_id <> nullif(current_setting('app.organization_id',true),'') THEN
    RAISE EXCEPTION 'equivalent offer unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT o.order_item_id INTO v_item_id FROM public.order_item_equivalent_offer o
    JOIN public.customer_order_item i ON i.id = o.order_item_id
    JOIN public.customer_order ord ON ord.id = i.order_id
   WHERE o.id = target_offer_id AND ord.organization_id = target_org_id AND ord.actor_user_id = target_user_id
     AND public.gphkm_is_active_org_member(target_org_id, target_user_id);
  IF v_item_id IS NULL THEN RAISE EXCEPTION 'equivalent offer unavailable' USING ERRCODE = '42501'; END IF;

  SELECT f.* INTO v_fulfillment FROM public.order_item_fulfillment f
    WHERE f.order_item_id = v_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'equivalent offer unavailable' USING ERRCODE = '42501'; END IF;
  SELECT fs.supplier_id, fs.route_generation, fs.last_equivalent_offer_id
    INTO v_current_supplier, v_route_generation, v_last_offer
    FROM public.order_item_fulfillment_supplier fs WHERE fs.order_item_id = v_item_id FOR UPDATE;
  IF NOT FOUND OR v_last_offer = target_offer_id THEN
    RAISE EXCEPTION 'equivalent offer is stale or already applied' USING ERRCODE = '42501';
  END IF;

  SELECT max(e.created_at) INTO v_latest_accepted_at
    FROM public.order_item_equivalent_offer_event e
    JOIN public.order_item_equivalent_offer o ON o.id = e.offer_id
   WHERE o.order_item_id = v_item_id AND e.event_type = 'ACCEPTED';
  SELECT e.created_at INTO v_offer_accepted_at FROM public.order_item_equivalent_offer_event e
   WHERE e.offer_id = target_offer_id AND e.event_type = 'ACCEPTED'
     AND e.actor_user_id = target_user_id ORDER BY e.created_at DESC, e.id DESC LIMIT 1;
  IF v_offer_accepted_at IS NULL OR v_offer_accepted_at IS DISTINCT FROM v_latest_accepted_at
    OR EXISTS (
      SELECT 1 FROM (
        SELECT DISTINCT ON (e.offer_id) e.offer_id, e.event_type, e.created_at
          FROM public.order_item_equivalent_offer_event e
          JOIN public.order_item_equivalent_offer o ON o.id = e.offer_id
         WHERE o.order_item_id = v_item_id
         ORDER BY e.offer_id, e.created_at DESC, e.id DESC
      ) latest WHERE latest.event_type = 'OFFERED' AND latest.created_at > v_offer_accepted_at
    ) THEN
    RAISE EXCEPTION 'equivalent offer is not the current resolved customer decision' USING ERRCODE = '42501';
  END IF;

  SELECT o.support_case_id, o.content_request_id, o.content_version_id, r.supplier_id,
    r.recipient_email, r.content_hash, r.route_generation
    INTO v_case_id, v_request_id, v_version_id, v_next_supplier, v_next_recipient, v_content_digest, v_target_generation
    FROM public.order_item_equivalent_offer o
    JOIN public.order_item_equivalent_offer_route r ON r.offer_id = o.id
    JOIN public.customer_order_item i ON i.id = o.order_item_id
    JOIN public.customer_order ord ON ord.id = i.order_id
   WHERE o.id = target_offer_id AND o.order_item_id = v_item_id
     AND ord.organization_id = target_org_id AND ord.actor_user_id = target_user_id
     AND public.gphkm_is_active_org_member(target_org_id, target_user_id)
     AND EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_event e
       WHERE e.offer_id = o.id AND e.event_type = 'ACCEPTED'
         AND e.actor_user_id = target_user_id AND e.content_hash = r.content_hash)
     AND NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_event e
       WHERE e.offer_id = o.id AND e.event_type = 'DECLINED');
  IF NOT FOUND OR v_next_supplier IS NULL OR v_next_supplier = v_current_supplier
    OR v_target_generation <> v_route_generation + 1
    OR NOT EXISTS (SELECT 1 FROM public.order_item_content_change_event e
      WHERE e.request_id = v_request_id AND e.event_type = 'CONSENTED' AND e.version_id = v_version_id
        AND e.content_hash = v_content_digest AND e.actor_user_id = target_user_id)
    OR NOT EXISTS (SELECT 1 FROM public.supplier_contact c
      WHERE c.supplier_id = v_next_supplier AND c.is_primary AND lower(c.email) = lower(v_next_recipient))
    OR NOT EXISTS (SELECT 1 FROM public.support_case c
      JOIN public.supplier_fulfillment_outcome outcome ON outcome.support_case_id = c.id
      WHERE c.id = v_case_id AND c.order_item_id = v_item_id AND c.state NOT IN ('RESOLVED','CLOSED')
        AND outcome.order_item_id = v_item_id AND outcome.supplier_id = v_current_supplier) THEN
    RAISE EXCEPTION 'equivalent offer consent, case, or current supplier failure is unavailable' USING ERRCODE = '42501';
  END IF;

  IF v_fulfillment.state IN ('COMPLETED','CANCELED_REFUNDED','CANCELLATION_REQUESTED') THEN
    RAISE EXCEPTION 'equivalent offer is closed for this order item' USING ERRCODE = '42501';
  END IF;
  v_recovery := v_fulfillment.handed_off_at IS NOT NULL OR v_fulfillment.work_started_at IS NOT NULL
    OR v_fulfillment.state IN ('IN_FULFILLMENT','PUBLICATION_PENDING','EVIDENCE_REVIEW','HANDOFF_PENDING');
  IF v_recovery AND NOT EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome
      JOIN public.support_case c ON c.id = outcome.support_case_id
      WHERE outcome.order_item_id = v_item_id AND outcome.supplier_id = v_current_supplier
        AND outcome.support_case_id = v_case_id AND c.state NOT IN ('RESOLVED','CLOSED')) THEN
    RAISE EXCEPTION 'post-handoff routing requires a current supplier failure case' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM public.supplier_packet_item pi
    JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = pi.packet_id
    WHERE pi.order_item_id = v_item_id AND attempt.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERY_ISSUE')) THEN
    RAISE EXCEPTION 'reconcile the supplier packet attempt before changing its route' USING ERRCODE = '42501';
  END IF;

  UPDATE public.order_item_fulfillment_supplier SET supplier_id = v_next_supplier,
    route_generation = route_generation + 1, last_equivalent_offer_id = target_offer_id
   WHERE order_item_id = v_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'equivalent offer route is unavailable' USING ERRCODE = '42501'; END IF;
  UPDATE public.order_item_fulfillment SET state = 'READY_FOR_HANDOFF', state_before_hold = NULL,
    customer_status = 'PREPARING', updated_at = clock_timestamp() WHERE order_item_id = v_item_id;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_apply_equivalent_offer_acceptance(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_apply_equivalent_offer_acceptance(text,text,text) TO gphkm_runtime;

-- Only the latest offer actually applied to this route generation resolves a
-- failure. An old accepted event cannot unlock handoff after later failures.
CREATE OR REPLACE FUNCTION public.gphkm_gate_unresolved_supplier_failure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.supplier_fulfillment_outcome outcome
    JOIN public.support_case c ON c.id = outcome.support_case_id
    WHERE outcome.order_item_id = NEW.order_item_id
      AND NOT EXISTS (
        SELECT 1 FROM public.order_item_fulfillment_supplier fs
        JOIN public.order_item_equivalent_offer offer ON offer.order_item_id = fs.order_item_id
        JOIN public.order_item_equivalent_offer_route route ON route.offer_id = offer.id
        JOIN LATERAL (SELECT e.event_type, e.actor_user_id FROM public.order_item_equivalent_offer_event e
          WHERE e.offer_id = offer.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) latest ON true
        WHERE fs.order_item_id = NEW.order_item_id AND offer.support_case_id = c.id
          AND latest.event_type = 'ACCEPTED' AND latest.actor_user_id = c.opened_by_user_id
          AND route.route_generation <= fs.route_generation
      )
  ) AND NEW.state NOT IN ('ON_HOLD','CANCELLATION_REQUESTED','CANCELED_REFUNDED')
    AND NOT (OLD.state = 'ON_HOLD' AND NEW.state = OLD.state_before_hold AND OLD.state_before_hold IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome
        JOIN public.support_case c ON c.id = outcome.support_case_id
        JOIN public.order_item_equivalent_offer offer ON offer.support_case_id = c.id
        JOIN public.order_item_equivalent_offer_event event ON event.offer_id = offer.id
        WHERE outcome.order_item_id = NEW.order_item_id AND event.event_type = 'DECLINED')) THEN
    RAISE EXCEPTION 'resolve supplier failure through customer-approved equivalent or item cancellation before handoff' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_gate_unresolved_supplier_failure() FROM PUBLIC;

-- Work-start proof must belong to the current route generation and latest
-- active packet for that supplier; old A evidence fails after A -> B -> A.
CREATE OR REPLACE FUNCTION public.gphkm_require_persisted_supplier_handoff() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE route_supplier_id text; route_generation_value integer;
BEGIN
  IF NOT ((NEW.state = 'IN_FULFILLMENT' AND OLD.state IS DISTINCT FROM NEW.state)
      OR (NEW.work_started_at IS NOT NULL AND OLD.work_started_at IS DISTINCT FROM NEW.work_started_at)) THEN
    RETURN NEW;
  END IF;
  SELECT fs.supplier_id, fs.route_generation INTO route_supplier_id, route_generation_value
    FROM public.order_item_fulfillment_supplier fs
    WHERE fs.order_item_id = NEW.order_item_id FOR KEY SHARE OF fs;
  IF route_supplier_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.supplier_packet_item pi
    JOIN public.supplier_packet packet ON packet.id = pi.packet_id
    JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = packet.id
    WHERE pi.order_item_id = NEW.order_item_id
      AND pi.route_generation = route_generation_value AND packet.supplier_id = route_supplier_id
      AND packet.superseded_at IS NULL
      AND packet.version = (SELECT max(latest.version) FROM public.supplier_packet latest
        JOIN public.supplier_packet_item latest_item ON latest_item.packet_id = latest.id
        WHERE latest_item.order_item_id = NEW.order_item_id AND latest_item.route_generation = route_generation_value
          AND latest.supplier_id = route_supplier_id AND latest.superseded_at IS NULL AND latest.hold_reason IS NULL)
      AND ((attempt.type = 'SEND' AND attempt.state = 'DELIVERED' AND attempt.delivered_at IS NOT NULL)
        OR (attempt.type IN ('MANUAL_SENT','MANUAL_SEND') AND attempt.state = 'MANUAL_SENT' AND attempt.sent_at IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'supplier placement requires delivery or manual handoff evidence for the current packet route' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_require_persisted_supplier_handoff() FROM PUBLIC;

-- A packet is valid for customer display/send only when its route generation
-- remains current. This helper is a safe, narrow customer-decision projection.
CREATE OR REPLACE FUNCTION public.gphkm_customer_can_decide_equivalent_offer(target_offer_id text, target_user_id text, target_org_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.order_item_equivalent_offer offer
    JOIN public.customer_order_item item ON item.id = offer.order_item_id
    JOIN public.customer_order ord ON ord.id = item.order_id
    JOIN public.order_item_fulfillment fulfillment ON fulfillment.order_item_id = item.id
    JOIN public.order_item_fulfillment_supplier route ON route.order_item_id = item.id
    JOIN public.order_item_equivalent_offer_route offered_route ON offered_route.offer_id = offer.id
    JOIN public.order_item_content_change_request content_request ON content_request.id = offer.content_request_id
      AND content_request.order_item_id = item.id AND content_request.target_supplier_id = offered_route.supplier_id
    JOIN public.order_item_content_version content_version ON content_version.id = offer.content_version_id
      AND content_version.request_id = content_request.id AND content_version.content_hash = offered_route.content_hash
    JOIN public.support_case c ON c.id = offer.support_case_id
    JOIN public.supplier_fulfillment_outcome outcome ON outcome.support_case_id = c.id
      AND outcome.order_item_id = item.id AND outcome.supplier_id = route.supplier_id
    JOIN LATERAL (SELECT e.event_type FROM public.order_item_equivalent_offer_event e
      WHERE e.offer_id = offer.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) latest ON true
    WHERE target_user_id = nullif(current_setting('app.user_id', true), '')
      AND target_org_id = nullif(current_setting('app.organization_id', true), '')
      AND offer.id = target_offer_id AND ord.organization_id = target_org_id
      AND ord.actor_user_id = target_user_id AND public.gphkm_is_active_org_member(target_org_id, target_user_id)
      AND latest.event_type = 'OFFERED' AND offered_route.supplier_id IS DISTINCT FROM route.supplier_id
      AND offered_route.route_generation = route.route_generation + 1
      AND EXISTS (SELECT 1 FROM public.order_item_content_change_event approval
        WHERE approval.request_id = offer.content_request_id AND approval.event_type = 'APPROVED'
          AND approval.version_id = offer.content_version_id AND approval.content_hash = offered_route.content_hash)
      AND c.state NOT IN ('RESOLVED','CLOSED') AND fulfillment.state NOT IN ('COMPLETED','CANCELED_REFUNDED','CANCELLATION_REQUESTED')
      AND NOT EXISTS (SELECT 1 FROM public.order_item_fulfillment_supplier fs
        WHERE fs.order_item_id = item.id AND fs.last_equivalent_offer_id = offer.id)
      AND NOT EXISTS (SELECT 1 FROM public.supplier_packet_item pi
        JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = pi.packet_id
        WHERE pi.order_item_id = item.id AND attempt.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERY_ISSUE'))
      AND NOT EXISTS (SELECT 1 FROM (
        SELECT DISTINCT ON (e.offer_id) e.offer_id, e.event_type
          FROM public.order_item_equivalent_offer_event e
          JOIN public.order_item_equivalent_offer other_offer ON other_offer.id = e.offer_id
         WHERE other_offer.order_item_id = item.id
         ORDER BY e.offer_id, e.created_at DESC, e.id DESC
      ) pending WHERE pending.event_type = 'OFFERED' AND pending.offer_id <> offer.id)
      AND NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_event newer
        JOIN public.order_item_equivalent_offer newer_offer ON newer_offer.id = newer.offer_id
        WHERE newer_offer.order_item_id = item.id AND newer.created_at > offer.created_at
          AND newer.event_type = 'ACCEPTED')
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_customer_can_decide_equivalent_offer(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_customer_can_decide_equivalent_offer(text,text,text) TO gphkm_runtime;

-- DELIVERY_ISSUE can be safely cleared only after an audited confirmation that
-- delivery did not occur. Uncertain states remain blocked until that event.
CREATE OR REPLACE FUNCTION public.gphkm_packet_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE latest_event public.supplier_packet_attempt_event%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.type = 'SEND' AND NEW.state <> 'SENDING')
      OR (NEW.type = 'MANUAL_SEND' AND NEW.state <> 'SENDING')
      OR (NEW.type IN ('EML_EXPORT','PDF_EXPORT') AND NEW.state <> 'EXPORTED')
      OR (NEW.type = 'MANUAL_SENT' AND NEW.state <> 'MANUAL_SENT') THEN
      RAISE EXCEPTION 'invalid initial supplier packet attempt state' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' OR (NEW.id,NEW.packet_id,NEW.type,NEW.actor_user_id,NEW.recipient,NEW.idempotency_key,
      NEW.resend_reason,NEW.provider,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.packet_id,OLD.type,OLD.actor_user_id,OLD.recipient,OLD.idempotency_key,
      OLD.resend_reason,OLD.provider,OLD.created_at) THEN
    RAISE EXCEPTION 'supplier packet attempt identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.state <> OLD.state THEN
    SELECT * INTO latest_event FROM public.supplier_packet_attempt_event e
     WHERE e.attempt_id = OLD.id AND e.actor_user_id IS NOT DISTINCT FROM nullif(current_setting('app.user_id',true),'')
       AND e.from_state IS NOT DISTINCT FROM OLD.state AND e.to_state = NEW.state
       AND e.created_at >= transaction_timestamp() ORDER BY e.created_at DESC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'packet attempt state change requires append-only history' USING ERRCODE = '23514'; END IF;
    IF OLD.type = 'MANUAL_SEND' THEN
      IF OLD.state <> 'SENDING' OR NEW.state NOT IN ('MANUAL_SENT','RECONCILED_FAILED')
        OR OLD.manual_message_reference IS NOT NULL OR OLD.sent_at IS NOT NULL OR NEW.provider_reference IS NOT NULL
        OR NEW.accepted_at IS NOT NULL OR NEW.delivered_at IS NOT NULL OR NEW.unknown_at IS NOT NULL
        OR (NEW.state = 'MANUAL_SENT' AND (NEW.sent_at IS NULL OR NEW.manual_message_reference IS NULL
          OR NEW.sent_at < OLD.created_at OR NEW.sent_at > now() + interval '5 minutes' OR NEW.resolved_at IS NULL))
        OR (NEW.state = 'RECONCILED_FAILED' AND (NEW.sent_at IS NOT NULL OR NEW.manual_message_reference IS NOT NULL OR NEW.resolved_at IS NULL)) THEN
        RAISE EXCEPTION 'invalid manual packet attempt resolution' USING ERRCODE = '23514';
      END IF;
    ELSIF (NEW.manual_message_reference,NEW.sent_at) IS DISTINCT FROM (OLD.manual_message_reference,OLD.sent_at) THEN
      RAISE EXCEPTION 'manual handoff evidence is immutable for this attempt type' USING ERRCODE = '23514';
    END IF;
    IF NOT ((OLD.type = 'SEND' AND OLD.state = 'SENDING' AND NEW.state IN ('ACCEPTED','DELIVERED','UNKNOWN','DELIVERY_ISSUE','RECONCILED_FAILED'))
      OR (OLD.type = 'SEND' AND OLD.state = 'UNKNOWN' AND NEW.state IN ('ACCEPTED','DELIVERED','DELIVERY_ISSUE','RECONCILED_FAILED'))
      OR (OLD.type = 'SEND' AND OLD.state = 'ACCEPTED' AND NEW.state IN ('DELIVERED','DELIVERY_ISSUE'))
      OR (OLD.type = 'SEND' AND OLD.state = 'DELIVERY_ISSUE' AND NEW.state IN ('DELIVERED','RECONCILED_FAILED'))
      OR (OLD.type = 'MANUAL_SEND' AND OLD.state = 'SENDING' AND NEW.state IN ('MANUAL_SENT','RECONCILED_FAILED'))) THEN
      RAISE EXCEPTION 'invalid supplier packet attempt transition' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.type = 'MANUAL_SEND' THEN
    IF (NEW.id,NEW.packet_id,NEW.type,NEW.actor_user_id,NEW.recipient,NEW.idempotency_key,NEW.resend_reason,
        NEW.provider,NEW.provider_reference,NEW.manual_message_reference,NEW.sent_at,NEW.accepted_at,NEW.delivered_at,
        NEW.unknown_at,NEW.resolved_at,NEW.created_at,NEW.state)
       IS DISTINCT FROM (OLD.id,OLD.packet_id,OLD.type,OLD.actor_user_id,OLD.recipient,OLD.idempotency_key,OLD.resend_reason,
        OLD.provider,OLD.provider_reference,OLD.manual_message_reference,OLD.sent_at,OLD.accepted_at,OLD.delivered_at,
        OLD.unknown_at,OLD.resolved_at,OLD.created_at,OLD.state) THEN
      RAISE EXCEPTION 'manual packet attempt evidence requires an audited state transition' USING ERRCODE = '23514';
    END IF;
  ELSIF (NEW.manual_message_reference,NEW.sent_at) IS DISTINCT FROM (OLD.manual_message_reference,OLD.sent_at) THEN
    RAISE EXCEPTION 'manual handoff evidence requires a state transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_packet_attempt_guard() FROM PUBLIC;

-- A supplier-failure case stays actionable while its customer decision is
-- pending or declined. Close only after the exact case's accepted route is
-- current, or the placement has been canceled/refunded. This helper is also
-- used by the service for a clear error; the trigger below is authoritative.
CREATE OR REPLACE FUNCTION public.gphkm_supplier_failure_case_can_close(target_case_id text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT (public.gphkm_support_admin_access(target_case_id, nullif(current_setting('app.user_id', true), ''))
      OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN'))
    AND NOT EXISTS (
    SELECT 1 FROM public.supplier_fulfillment_outcome outcome
    JOIN public.support_case c ON c.id = outcome.support_case_id
    JOIN public.order_item_fulfillment fulfillment ON fulfillment.order_item_id = outcome.order_item_id
    WHERE outcome.support_case_id = target_case_id
      AND fulfillment.state <> 'CANCELED_REFUNDED'
      AND NOT EXISTS (
        SELECT 1 FROM public.order_item_fulfillment_supplier current_route
        JOIN public.order_item_equivalent_offer offer
          ON offer.id = current_route.last_equivalent_offer_id
         AND offer.order_item_id = current_route.order_item_id
         AND offer.support_case_id = c.id
        JOIN public.order_item_equivalent_offer_route offer_route
          ON offer_route.offer_id = offer.id
         AND offer_route.supplier_id = current_route.supplier_id
         AND offer_route.route_generation = current_route.route_generation
        JOIN LATERAL (
          SELECT event.event_type, event.actor_user_id
            FROM public.order_item_equivalent_offer_event event
           WHERE event.offer_id = offer.id
           ORDER BY event.created_at DESC, event.id DESC LIMIT 1
        ) latest ON latest.event_type = 'ACCEPTED' AND latest.actor_user_id = c.opened_by_user_id
        WHERE current_route.order_item_id = outcome.order_item_id
      )
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_failure_case_can_close(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_supplier_failure_case_can_close(text) TO gphkm_runtime;

-- The support-case row is already locked by UPDATE. Lock the fulfillment item
-- before evaluating the current route, matching acceptance's item→route order.
-- Acceptance only reads the case row, so a close racing acceptance cannot form
-- a lock cycle; it either observes the accepted pointer or remains blocked.
CREATE OR REPLACE FUNCTION public.gphkm_guard_supplier_failure_case_close() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE item_ref text;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state OR NEW.state NOT IN ('RESOLVED','CLOSED') THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome WHERE outcome.support_case_id = OLD.id) THEN
    RETURN NEW;
  END IF;
  SELECT c.order_item_id INTO item_ref FROM public.support_case c WHERE c.id = OLD.id;
  PERFORM 1 FROM public.order_item_fulfillment fulfillment
   WHERE fulfillment.order_item_id = item_ref FOR UPDATE;
  PERFORM 1 FROM public.order_item_fulfillment_supplier route
   WHERE route.order_item_id = item_ref FOR KEY SHARE;
  IF NOT public.gphkm_supplier_failure_case_can_close(OLD.id) THEN
    RAISE EXCEPTION 'supplier failure case must remain active until the customer-approved route is accepted or the placement is canceled/refunded'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_guard_supplier_failure_case_close() FROM PUBLIC;
CREATE TRIGGER support_case_supplier_failure_close_guard
  BEFORE UPDATE OF state ON public.support_case
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_guard_supplier_failure_case_close();

-- Migration 0135 serialized consent against handoff but replaced the earlier
-- equivalent-offer exception. Restore only the exact accepted recovery path:
-- item lock, current route lock, current-supplier failure case, owner decision,
-- fresh next-generation recipient binding, and no ambiguous transport state.
CREATE OR REPLACE FUNCTION public.gphkm_validate_content_change_event_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  version_row public.order_item_content_version%ROWTYPE;
  request_row public.order_item_content_change_request%ROWTYPE;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
  current_supplier_id text;
  current_generation integer;
  recovery_required boolean;
BEGIN
  IF NEW.event_type IN ('APPROVED','CONSENTED') THEN
    IF NEW.version_id IS NULL THEN RAISE EXCEPTION 'approved content event requires a version' USING ERRCODE = '23514'; END IF;
    SELECT * INTO version_row FROM public.order_item_content_version v
     WHERE v.id = NEW.version_id AND v.request_id = NEW.request_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'content version does not belong to request' USING ERRCODE = '23514'; END IF;
    IF NEW.content_hash IS DISTINCT FROM version_row.content_hash THEN
      RAISE EXCEPTION 'event hash does not match bound content, supplier and recipient' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.event_type <> 'CONSENTED' THEN RETURN NEW; END IF;

  SELECT * INTO request_row FROM public.order_item_content_change_request r WHERE r.id = NEW.request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'content request unavailable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment f
   WHERE f.order_item_id = request_row.order_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '23514'; END IF;
  SELECT route.supplier_id, route.route_generation INTO current_supplier_id, current_generation
    FROM public.order_item_fulfillment_supplier route
   WHERE route.order_item_id = request_row.order_item_id FOR KEY SHARE;

  recovery_required := fulfillment_row.handed_off_at IS NOT NULL OR fulfillment_row.work_started_at IS NOT NULL
    OR fulfillment_row.state IN ('HANDOFF_PENDING','IN_FULFILLMENT','PUBLICATION_PENDING','EVIDENCE_REVIEW','COMPLETED','CANCELED_REFUNDED','CANCELLATION_REQUESTED')
    OR EXISTS (SELECT 1 FROM public.supplier_packet_item pi
      JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = pi.packet_id
      WHERE pi.order_item_id = request_row.order_item_id
        AND attempt.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERED','DELIVERY_ISSUE','MANUAL_SENT'));
  IF recovery_required AND NOT EXISTS (
    SELECT 1 FROM public.order_item_equivalent_offer offer
    JOIN public.order_item_equivalent_offer_route offered_route ON offered_route.offer_id = offer.id
    JOIN public.customer_order_item item ON item.id = offer.order_item_id
    JOIN public.customer_order ord ON ord.id = item.order_id
    JOIN public.support_case c ON c.id = offer.support_case_id
    JOIN public.supplier_fulfillment_outcome outcome ON outcome.support_case_id = c.id
      AND outcome.order_item_id = item.id AND outcome.supplier_id = current_supplier_id
    JOIN public.supplier_contact contact ON contact.supplier_id = offered_route.supplier_id AND contact.is_primary
    JOIN LATERAL (
      SELECT event.event_type, event.actor_user_id, event.content_hash, event.notice_version
        FROM public.order_item_equivalent_offer_event event
       WHERE event.offer_id = offer.id
       ORDER BY event.created_at DESC, event.id DESC LIMIT 1
    ) latest ON latest.event_type = 'ACCEPTED'
    WHERE offer.content_request_id = NEW.request_id AND offer.content_version_id = NEW.version_id
      AND offer.order_item_id = request_row.order_item_id AND offer.support_case_id = c.id
      AND ord.actor_user_id = NEW.actor_user_id
      AND ord.organization_id = nullif(current_setting('app.organization_id', true), '')
      AND public.gphkm_is_active_org_member(ord.organization_id, NEW.actor_user_id)
      AND c.opened_by_user_id = NEW.actor_user_id AND c.state NOT IN ('RESOLVED','CLOSED')
      AND request_row.target_supplier_id = offered_route.supplier_id
      AND offered_route.supplier_id IS DISTINCT FROM current_supplier_id
      AND offered_route.route_generation = current_generation + 1
      AND offered_route.content_hash = NEW.content_hash
      AND lower(contact.email) = lower(offered_route.recipient_email)
      AND latest.actor_user_id = NEW.actor_user_id
      AND latest.content_hash = NEW.content_hash
      AND latest.notice_version = NEW.notice_version
      AND NEW.notice_version IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.supplier_packet_item pi
        JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = pi.packet_id
        WHERE pi.order_item_id = request_row.order_item_id
          AND attempt.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERY_ISSUE'))
  ) THEN
    RAISE EXCEPTION 'content consent closes after handoff unless bound to the current customer-approved supplier recovery' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_validate_content_change_event_binding() FROM PUBLIC;
