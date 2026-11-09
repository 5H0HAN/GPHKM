ALTER TABLE "order_item_content_change_request" ADD COLUMN "purpose" text DEFAULT 'CONTENT_CHANGE' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_item_content_change_request" ADD CONSTRAINT "order_item_content_change_request_purpose_valid" CHECK ("order_item_content_change_request"."purpose" in ('CONTENT_CHANGE', 'RECIPIENT_RECONSENT'));--> statement-breakpoint

-- A replacement after dispatch is allowed only after a provider accepted the
-- message, reported a delivery issue, and staff explicitly reconciled it as
-- not delivered. The original handoff cutoff remains in place.
CREATE FUNCTION public.gphkm_supplier_packet_retry_eligible(target_item_id text, candidate_packet_id text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
  route_supplier_id text;
  current_route_generation integer;
  current_recipient text;
  current_order_id text;
  candidate_order_id text;
  candidate_supplier_id text;
  candidate_version integer;
  caller_id text := nullif(current_setting('app.user_id', true), '');
  eligible boolean := false;
BEGIN
  IF caller_id IS NOT NULL AND NOT public.gphkm_staff_can_read_order_item(target_item_id, caller_id)
     AND NOT public.gphkm_content_change_customer(target_item_id, caller_id,
       nullif(current_setting('app.organization_id', true), '')) THEN RETURN false; END IF;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment fulfillment
   WHERE fulfillment.order_item_id = target_item_id;
  IF NOT FOUND OR fulfillment_row.state <> 'HANDOFF_PENDING' OR fulfillment_row.handed_off_at IS NULL
      OR fulfillment_row.work_started_at IS NOT NULL THEN RETURN false; END IF;

  SELECT route.supplier_id, route.route_generation, lower(btrim(contact.email))
    INTO route_supplier_id, current_route_generation, current_recipient
    FROM public.order_item_fulfillment_supplier route
    JOIN public.supplier supplier_row ON supplier_row.id = route.supplier_id AND supplier_row.status = 'ACTIVE'
    JOIN public.supplier_contact contact ON contact.supplier_id = route.supplier_id AND contact.is_primary
   WHERE route.order_item_id = target_item_id;
  IF route_supplier_id IS NULL OR current_recipient IS NULL THEN RETURN false; END IF;
  SELECT item.order_id INTO current_order_id FROM public.customer_order_item item WHERE item.id = target_item_id;
  IF current_order_id IS NULL THEN RETURN false; END IF;

  IF candidate_packet_id IS NOT NULL THEN
    SELECT packet.order_id, packet.supplier_id, packet.version
      INTO candidate_order_id, candidate_supplier_id, candidate_version
      FROM public.supplier_packet packet WHERE packet.id = candidate_packet_id;
    IF NOT FOUND OR candidate_supplier_id IS DISTINCT FROM route_supplier_id THEN RETURN false; END IF;
  END IF;

  WITH prior_packets AS (
    SELECT DISTINCT packet.id, packet.version, packet.recipient, packet.hold_reason
      FROM public.supplier_packet packet
      JOIN public.supplier_packet_item membership ON membership.packet_id = packet.id
     WHERE membership.order_item_id = target_item_id
       AND membership.route_generation = current_route_generation
       AND packet.supplier_id = route_supplier_id
       AND packet.order_id = coalesce(candidate_order_id, current_order_id)
       AND packet.version <= CASE WHEN candidate_packet_id IS NULL THEN coalesce((SELECT max(active.version) FROM public.supplier_packet active
          JOIN public.supplier_packet_item active_item ON active_item.packet_id = active.id
          WHERE active_item.order_item_id = target_item_id AND active_item.route_generation = current_route_generation
            AND active.supplier_id = route_supplier_id AND active.superseded_at IS NULL), -1) ELSE candidate_version - 1 END
  ), latest_prior_packet AS (
    SELECT prior.* FROM prior_packets prior ORDER BY prior.version DESC LIMIT 1
  ), prior_attempts AS (
    SELECT attempt.* FROM prior_packets prior
      JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = prior.id
  ), latest_prior_attempts AS (
    SELECT attempt.* FROM latest_prior_packet prior
      JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = prior.id
  )
  SELECT EXISTS (SELECT 1 FROM latest_prior_packet packet
      WHERE packet.hold_reason IS NULL AND lower(btrim(packet.recipient)) IS DISTINCT FROM current_recipient)
    AND EXISTS (SELECT 1 FROM latest_prior_attempts attempt
      WHERE attempt.type = 'SEND' AND attempt.state = 'RECONCILED_FAILED' AND attempt.accepted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.supplier_packet_attempt_event event
          WHERE event.attempt_id = attempt.id AND event.from_state = 'DELIVERY_ISSUE'
            AND event.to_state = 'RECONCILED_FAILED' AND event.reason_code = 'DELIVERY_ISSUE_CONFIRMED_NOT_DELIVERED'))
    AND (SELECT count(*) FROM latest_prior_attempts) = 1
    AND NOT EXISTS (SELECT 1 FROM prior_attempts attempt
      WHERE attempt.type <> 'SEND' OR attempt.state <> 'RECONCILED_FAILED' OR attempt.accepted_at IS NULL
        OR NOT EXISTS (SELECT 1 FROM public.supplier_packet_attempt_event event
          WHERE event.attempt_id = attempt.id AND event.from_state = 'DELIVERY_ISSUE'
            AND event.to_state = 'RECONCILED_FAILED' AND event.reason_code = 'DELIVERY_ISSUE_CONFIRMED_NOT_DELIVERED'))
    AND NOT EXISTS (SELECT 1 FROM prior_packets prior
      JOIN public.supplier_packet_acknowledgement acknowledgement ON acknowledgement.packet_id = prior.id)
    AND NOT EXISTS (SELECT 1 FROM prior_packets prior
      JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = prior.id
      JOIN public.supplier_packet_provider_event event ON event.attempt_id = attempt.id
      WHERE event.state = 'RECONCILIATION_REQUIRED' OR event.event_type = 'email.delivered')
    AND NOT EXISTS (SELECT 1 FROM prior_packets prior
      JOIN public.supplier_packet_manual_evidence evidence ON evidence.packet_id = prior.id)
    INTO eligible;
  RETURN coalesce(eligible, false);
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_packet_retry_eligible(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_supplier_packet_retry_eligible(text, text) TO gphkm_runtime;
--> statement-breakpoint

-- Serialize recipient edits with packet reservation. App commands take this
-- advisory lock before packet/item rows; the trigger is the database fallback.
CREATE FUNCTION public.gphkm_supplier_contact_recipient_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE supplier_ref text;
BEGIN
  supplier_ref := CASE WHEN TG_OP = 'DELETE' THEN OLD.supplier_id ELSE NEW.supplier_id END;
  IF TG_OP = 'UPDATE' AND OLD.supplier_id IS DISTINCT FROM NEW.supplier_id THEN
    RAISE EXCEPTION 'supplier contacts cannot move between suppliers' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.supplier_id = NEW.supplier_id
      AND OLD.email IS NOT DISTINCT FROM NEW.email AND OLD.is_primary IS NOT DISTINCT FROM NEW.is_primary THEN
    RETURN NEW;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gphkm:supplier-contact:' || supplier_ref, 0::bigint));
  IF EXISTS (
    SELECT 1 FROM public.supplier_packet packet
    JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = packet.id
    WHERE packet.supplier_id = supplier_ref
      AND attempt.type IN ('SEND', 'MANUAL_SEND')
      AND attempt.state IN ('SENDING', 'UNKNOWN')
  ) THEN
    RAISE EXCEPTION 'supplier recipient cannot change while a send outcome is unresolved' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_contact_recipient_guard() FROM PUBLIC;
CREATE TRIGGER supplier_contact_recipient_update_guard
  BEFORE INSERT OR UPDATE OF email, is_primary, supplier_id OR DELETE ON public.supplier_contact
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_contact_recipient_guard();
--> statement-breakpoint

-- Only assigned Admins and Super Admins can create the narrow re-consent
-- request. The request is tied to the orderer, unchanged original content,
-- current recipient, and a verified post-acceptance non-delivery.
CREATE POLICY content_change_request_recipient_reconsent_staff_insert
  ON public.order_item_content_change_request FOR INSERT TO gphkm_runtime
  WITH CHECK (
    order_item_content_change_request.purpose = 'RECIPIENT_RECONSENT'
    AND requested_by_user_id = (SELECT order_row.actor_user_id FROM public.customer_order_item item
      JOIN public.customer_order order_row ON order_row.id = item.order_id WHERE item.id = order_item_content_change_request.order_item_id)
    AND public.gphkm_staff_can_read_order_item(order_item_content_change_request.order_item_id, nullif(current_setting('app.user_id', true), ''))
    AND public.gphkm_supplier_packet_retry_eligible(order_item_content_change_request.order_item_id, NULL)
  );
--> statement-breakpoint
CREATE POLICY content_change_version_recipient_reconsent_staff_insert
  ON public.order_item_content_version FOR INSERT TO gphkm_runtime
  WITH CHECK (
    approved_by_user_id = nullif(current_setting('app.user_id', true), '')
    AND EXISTS (SELECT 1 FROM public.order_item_content_change_request request
      WHERE request.id = order_item_content_version.request_id AND request.purpose = 'RECIPIENT_RECONSENT'
        AND request.order_item_id = order_item_content_version.order_item_id)
    AND public.gphkm_staff_can_read_order_item(order_item_content_version.order_item_id, approved_by_user_id)
    AND public.gphkm_supplier_packet_retry_eligible(order_item_content_version.order_item_id, NULL)
  );
--> statement-breakpoint
CREATE POLICY content_change_event_recipient_reconsent_staff_insert
  ON public.order_item_content_change_event FOR INSERT TO gphkm_runtime
  WITH CHECK (
    actor_user_id = nullif(current_setting('app.user_id', true), '')
    AND event_type IN ('REQUESTED', 'APPROVED')
    AND EXISTS (SELECT 1 FROM public.order_item_content_change_request request
      WHERE request.id = order_item_content_change_event.request_id AND request.purpose = 'RECIPIENT_RECONSENT'
        AND public.gphkm_staff_can_read_order_item(request.order_item_id, actor_user_id)
        AND public.gphkm_supplier_packet_retry_eligible(request.order_item_id, NULL))
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_validate_content_change_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE fulfillment_row public.order_item_fulfillment%ROWTYPE; route_supplier text; current_route_generation integer; current_recipient text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.customer_order_item item WHERE item.id = NEW.order_item_id) THEN
    RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment fulfillment
   WHERE fulfillment.order_item_id = NEW.order_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '23514'; END IF;
  IF NEW.purpose = 'RECIPIENT_RECONSENT' THEN
    SELECT route.supplier_id, route.route_generation, lower(btrim(contact.email))
      INTO route_supplier, current_route_generation, current_recipient
      FROM public.order_item_fulfillment_supplier route
      JOIN public.supplier_contact contact ON contact.supplier_id = route.supplier_id AND contact.is_primary
     WHERE route.order_item_id = NEW.order_item_id;
    IF NOT public.gphkm_supplier_packet_retry_eligible(NEW.order_item_id, NULL)
       OR nullif(current_setting('app.staff_role', true), '') <> 'SUPER_ADMIN'
       OR NEW.target_supplier_id IS DISTINCT FROM route_supplier
       OR NEW.requested_by_user_id IS DISTINCT FROM (SELECT order_row.actor_user_id FROM public.customer_order_item item
           JOIN public.customer_order order_row ON order_row.id = item.order_id WHERE item.id = NEW.order_item_id)
       OR NOT EXISTS (
         SELECT 1 FROM public.supplier_packet packet
         JOIN public.supplier_packet_item membership ON membership.packet_id = packet.id
         JOIN LATERAL jsonb_array_elements(packet.packet->'items') packet_item ON packet_item->>'orderItemId' = NEW.order_item_id
         WHERE membership.order_item_id = NEW.order_item_id AND membership.route_generation = current_route_generation
           AND packet.superseded_at IS NULL AND packet.recipient IS DISTINCT FROM current_recipient
           AND packet_item->>'targetUrl' = NEW.target_url
           AND packet_item->>'anchorText' = NEW.anchor_text
           AND nullif(packet_item->>'instructions', '') IS NOT DISTINCT FROM NEW.instructions
           AND packet_item->>'article' = NEW.article_text
       ) THEN
      RAISE EXCEPTION 'recipient re-consent is unavailable for this order item' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.target_supplier_id IS NULL THEN
    IF fulfillment_row.handed_off_at IS NOT NULL OR fulfillment_row.state IN ('IN_FULFILLMENT','PUBLICATION_PENDING','EVIDENCE_REVIEW','COMPLETED','CANCELED_REFUNDED') THEN
      RAISE EXCEPTION 'content changes close after handoff' USING ERRCODE = '23514';
    END IF;
  ELSIF fulfillment_row.state IN ('COMPLETED','CANCELED_REFUNDED')
    OR NOT public.gphkm_staff_can_read_order_item(NEW.order_item_id, nullif(current_setting('app.user_id',true),''))
    OR NOT EXISTS (SELECT 1 FROM public.support_case case_row
      WHERE case_row.order_id = (SELECT item.order_id FROM public.customer_order_item item WHERE item.id = NEW.order_item_id)
        AND case_row.state NOT IN ('RESOLVED','CLOSED'))
    OR NOT EXISTS (SELECT 1 FROM public.supplier supplier_row
      JOIN public.supplier_contact contact ON contact.supplier_id = supplier_row.id
      WHERE supplier_row.id = NEW.target_supplier_id AND supplier_row.status = 'ACTIVE' AND contact.is_primary) THEN
    RAISE EXCEPTION 'content changes close after handoff' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.gphkm_validate_recipient_reconsent_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE request_row public.order_item_content_change_request%ROWTYPE;
  current_supplier_id text; current_recipient text; orderer_id text;
BEGIN
  SELECT * INTO request_row FROM public.order_item_content_change_request request WHERE request.id = NEW.request_id;
  IF NOT FOUND OR request_row.purpose <> 'RECIPIENT_RECONSENT' THEN RETURN NEW; END IF;
  SELECT route.supplier_id, lower(btrim(contact.email)), order_row.actor_user_id
    INTO current_supplier_id, current_recipient, orderer_id
    FROM public.order_item_fulfillment_supplier route
    JOIN public.supplier_contact contact ON contact.supplier_id = route.supplier_id AND contact.is_primary
    JOIN public.customer_order_item item ON item.id = route.order_item_id
    JOIN public.customer_order order_row ON order_row.id = item.order_id
   WHERE route.order_item_id = request_row.order_item_id;
  IF nullif(current_setting('app.staff_role', true), '') <> 'SUPER_ADMIN'
     OR NEW.approved_by_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')
     OR request_row.requested_by_user_id IS DISTINCT FROM orderer_id
     OR request_row.target_supplier_id IS DISTINCT FROM current_supplier_id
     OR NEW.order_item_id IS DISTINCT FROM request_row.order_item_id
     OR NEW.target_url IS DISTINCT FROM request_row.target_url
     OR NEW.anchor_text IS DISTINCT FROM request_row.anchor_text
     OR NEW.article_text IS DISTINCT FROM request_row.article_text
     OR NEW.instructions IS DISTINCT FROM coalesce(request_row.instructions, '')
     OR NEW.supplier_id IS DISTINCT FROM current_supplier_id
     OR lower(btrim(NEW.recipient_email)) IS DISTINCT FROM current_recipient
     OR NEW.version <> coalesce((SELECT max(version.version) FROM public.order_item_content_version version
       WHERE version.order_item_id = NEW.order_item_id), 0) + 1
     OR NOT public.gphkm_supplier_packet_retry_eligible(NEW.order_item_id, NULL) THEN
    RAISE EXCEPTION 'recipient re-consent version must preserve the approved packet content and bind the current recipient' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_validate_recipient_reconsent_version() FROM PUBLIC;
CREATE TRIGGER content_version_recipient_reconsent_validate
  BEFORE INSERT ON public.order_item_content_version
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_validate_recipient_reconsent_version();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_customer_approved_content(target_request_id text, target_user_id text, target_org_id text)
RETURNS TABLE(version_id text, version integer, content_hash text, target_url text, anchor_text text, article_text text, instructions text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT version_row.id, version_row.version, version_row.content_hash, version_row.target_url,
    version_row.anchor_text, version_row.article_text, version_row.instructions
  FROM public.order_item_content_version version_row
  JOIN public.order_item_content_change_request request ON request.id = version_row.request_id
  JOIN public.customer_order_item item ON item.id = request.order_item_id
  JOIN public.customer_order order_row ON order_row.id = item.order_id
  LEFT JOIN public.order_item_fulfillment_supplier route ON route.order_item_id = item.id
  LEFT JOIN public.supplier_contact contact ON contact.supplier_id = route.supplier_id AND contact.is_primary
  WHERE request.id = target_request_id AND request.requested_by_user_id = target_user_id
    AND order_row.actor_user_id = target_user_id AND order_row.organization_id = target_org_id
    AND public.gphkm_is_active_org_member(order_row.organization_id, target_user_id)
    AND EXISTS (SELECT 1 FROM public.order_item_content_change_event event
      WHERE event.request_id = request.id AND event.event_type = 'APPROVED'
        AND event.version_id = version_row.id AND event.content_hash = version_row.content_hash)
    AND version_row.order_item_id = item.id
    AND ((request.purpose = 'CONTENT_CHANGE' AND public.gphkm_change_request_before_handoff(item.id))
      OR (request.purpose = 'RECIPIENT_RECONSENT'
        AND version_row.supplier_id = route.supplier_id
        AND lower(btrim(version_row.recipient_email)) = lower(btrim(contact.email))
        AND public.gphkm_supplier_packet_retry_eligible(item.id, NULL)))
$$;
REVOKE ALL ON FUNCTION public.gphkm_customer_approved_content(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_customer_approved_content(text, text, text) TO gphkm_runtime;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_validate_content_change_event_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE version_row public.order_item_content_version%ROWTYPE;
  request_row public.order_item_content_change_request%ROWTYPE;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
  order_record public.customer_order%ROWTYPE;
  item_order_id text;
  locked_supplier_id text;
  current_supplier_id text; current_recipient text; recovery_required boolean;
BEGIN
  IF NEW.event_type IN ('APPROVED', 'CONSENTED') THEN
    IF NEW.version_id IS NULL THEN RAISE EXCEPTION 'approved content event requires a version' USING ERRCODE = '23514'; END IF;
    SELECT * INTO version_row FROM public.order_item_content_version version
     WHERE version.id = NEW.version_id AND version.request_id = NEW.request_id;
    IF NOT FOUND OR NEW.content_hash IS DISTINCT FROM version_row.content_hash THEN
      RAISE EXCEPTION 'event hash does not match bound content, supplier and recipient' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO request_row FROM public.order_item_content_change_request request WHERE request.id = NEW.request_id;
  IF request_row.purpose = 'RECIPIENT_RECONSENT' AND NEW.event_type IN ('REQUESTED','APPROVED')
     AND nullif(current_setting('app.staff_role', true), '') <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'recipient re-consent review requires Super Admin' USING ERRCODE = '42501';
  END IF;
  IF NEW.event_type <> 'CONSENTED' THEN RETURN NEW; END IF;
  SELECT item.order_id INTO item_order_id FROM public.customer_order_item item
   WHERE item.id = request_row.order_item_id;
  IF item_order_id IS NULL THEN RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '23514'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supplier_packet_prepare:' || item_order_id, 0::bigint));
  SELECT route.supplier_id INTO locked_supplier_id FROM public.order_item_fulfillment_supplier route
   WHERE route.order_item_id = request_row.order_item_id;
  IF locked_supplier_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gphkm:supplier-contact:' || locked_supplier_id, 0::bigint));
  END IF;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment fulfillment
   WHERE fulfillment.order_item_id = request_row.order_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '23514'; END IF;
  SELECT route.supplier_id, lower(btrim(contact.email)) INTO current_supplier_id, current_recipient
    FROM public.order_item_fulfillment_supplier route
    LEFT JOIN public.supplier_contact contact ON contact.supplier_id = route.supplier_id AND contact.is_primary
   WHERE route.order_item_id = request_row.order_item_id FOR KEY SHARE OF route;
  IF current_supplier_id IS DISTINCT FROM locked_supplier_id THEN
    RAISE EXCEPTION 'supplier route changed during content consent' USING ERRCODE = '40001';
  END IF;
  SELECT ord.* INTO order_record FROM public.customer_order_item item
    JOIN public.customer_order ord ON ord.id = item.order_id
   WHERE item.id = request_row.order_item_id;
  recovery_required := fulfillment_row.handed_off_at IS NOT NULL OR fulfillment_row.work_started_at IS NOT NULL
    OR fulfillment_row.state IN ('HANDOFF_PENDING','IN_FULFILLMENT','PUBLICATION_PENDING','EVIDENCE_REVIEW','COMPLETED','CANCELED_REFUNDED','CANCELLATION_REQUESTED')
    OR EXISTS (SELECT 1 FROM public.supplier_packet_item membership
      JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = membership.packet_id
      WHERE membership.order_item_id = request_row.order_item_id
        AND attempt.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERED','DELIVERY_ISSUE','MANUAL_SENT'));
  IF recovery_required AND NOT (
    request_row.purpose = 'RECIPIENT_RECONSENT'
    AND request_row.requested_by_user_id = NEW.actor_user_id
    AND order_record.actor_user_id = NEW.actor_user_id
    AND order_record.organization_id = nullif(current_setting('app.organization_id', true), '')
    AND public.gphkm_is_active_org_member(order_record.organization_id, NEW.actor_user_id)
    AND request_row.target_supplier_id = current_supplier_id
    AND version_row.supplier_id = current_supplier_id
    AND lower(btrim(version_row.recipient_email)) = current_recipient
    AND version_row.id = NEW.version_id AND version_row.content_hash = NEW.content_hash
    AND NEW.notice_version IS NOT NULL
    AND public.gphkm_supplier_packet_retry_eligible(request_row.order_item_id, NULL)
  ) AND NOT EXISTS (
    SELECT 1 FROM public.order_item_equivalent_offer offer
    JOIN public.order_item_equivalent_offer_route offered_route ON offered_route.offer_id = offer.id
    JOIN public.customer_order_item item ON item.id = offer.order_item_id
    JOIN public.customer_order order_row ON order_row.id = item.order_id
    JOIN public.support_case case_row ON case_row.id = offer.support_case_id
    JOIN public.supplier_fulfillment_outcome outcome ON outcome.support_case_id = case_row.id
      AND outcome.order_item_id = item.id AND outcome.supplier_id = current_supplier_id
    JOIN public.supplier_contact contact ON contact.supplier_id = offered_route.supplier_id AND contact.is_primary
    JOIN LATERAL (SELECT event.event_type, event.actor_user_id, event.content_hash, event.notice_version
      FROM public.order_item_equivalent_offer_event event WHERE event.offer_id = offer.id
      ORDER BY event.created_at DESC, event.id DESC LIMIT 1) latest ON latest.event_type = 'ACCEPTED'
    WHERE offer.content_request_id = NEW.request_id AND offer.content_version_id = NEW.version_id
      AND offer.order_item_id = request_row.order_item_id AND offer.support_case_id = case_row.id
      AND order_row.actor_user_id = NEW.actor_user_id
      AND order_row.organization_id = nullif(current_setting('app.organization_id', true), '')
      AND public.gphkm_is_active_org_member(order_row.organization_id, NEW.actor_user_id)
      AND case_row.state NOT IN ('RESOLVED','CLOSED')
      AND request_row.target_supplier_id = offered_route.supplier_id
      AND offered_route.supplier_id IS DISTINCT FROM current_supplier_id
      AND offered_route.content_hash = NEW.content_hash
      AND lower(contact.email) = lower(offered_route.recipient_email)
      AND latest.actor_user_id = NEW.actor_user_id AND latest.content_hash = NEW.content_hash
      AND latest.notice_version = NEW.notice_version AND NEW.notice_version IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.supplier_packet_item membership
        JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = membership.packet_id
        WHERE membership.order_item_id = request_row.order_item_id
          AND attempt.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERY_ISSUE'))
  ) THEN
    RAISE EXCEPTION 'content consent closes after handoff unless bound to a current customer-approved recovery' USING ERRCODE = '23514';
  END IF;
  IF NOT recovery_required AND NOT public.gphkm_change_request_before_handoff(request_row.order_item_id) THEN
    RAISE EXCEPTION 'content consent closes after handoff' USING ERRCODE = '23514';
  END IF;
  IF request_row.purpose = 'RECIPIENT_RECONSENT' AND NOT (
    request_row.requested_by_user_id = NEW.actor_user_id AND order_record.actor_user_id = NEW.actor_user_id
    AND current_supplier_id = version_row.supplier_id AND current_recipient = lower(btrim(version_row.recipient_email))
    AND public.gphkm_supplier_packet_retry_eligible(request_row.order_item_id, NULL)
  ) THEN RAISE EXCEPTION 'recipient changed before customer consent was recorded' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_packet_item_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  packet_row public.supplier_packet%ROWTYPE;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
  item_row public.customer_order_item%ROWTYPE;
  actual_order text;
  actual_org text;
  actual_supplier text;
  actual_route_generation integer;
  actual_recipient text;
  packet_item jsonb;
  packet_item_count integer;
  valid_base_consent boolean;
  valid_version_consent boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'packet item membership is immutable' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO packet_row FROM public.supplier_packet WHERE id = NEW.packet_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet item does not match the order-time fulfillment snapshot' USING ERRCODE = '23514';
  END IF;

  -- Lock item first, matching route writers, then validate its current route.
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment
   WHERE order_item_id = NEW.order_item_id FOR UPDATE;
  SELECT * INTO item_row FROM public.customer_order_item WHERE id = NEW.order_item_id;
  SELECT o.id, o.organization_id INTO actual_order, actual_org
    FROM public.customer_order_item oi JOIN public.customer_order o ON o.id = oi.order_id
   WHERE oi.id = NEW.order_item_id;
  SELECT route.supplier_id, route.route_generation, lower(btrim(contact.email))
    INTO actual_supplier, actual_route_generation, actual_recipient
    FROM public.order_item_fulfillment_supplier route
    LEFT JOIN public.supplier_contact contact ON contact.supplier_id = route.supplier_id AND contact.is_primary
   WHERE route.order_item_id = NEW.order_item_id;

  SELECT count(*) INTO packet_item_count
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(packet_row.packet->'items') = 'array'
      THEN packet_row.packet->'items' ELSE '[]'::jsonb END) candidate
   WHERE candidate->>'orderItemId' = NEW.order_item_id;
  IF packet_item_count = 1 THEN
    SELECT candidate INTO packet_item
      FROM jsonb_array_elements(packet_row.packet->'items') candidate
     WHERE candidate->>'orderItemId' = NEW.order_item_id;
  END IF;

  IF packet_row.packet->>'id' IS DISTINCT FROM packet_row.id
    OR packet_row.packet->>'orderId' IS DISTINCT FROM packet_row.order_id
    OR packet_row.packet->>'organizationId' IS DISTINCT FROM packet_row.organization_id
    OR packet_row.packet->>'supplierId' IS DISTINCT FROM packet_row.supplier_id
    OR lower(btrim(packet_row.packet->>'recipient')) IS DISTINCT FROM lower(btrim(packet_row.recipient))
    OR item_row.id IS NULL OR fulfillment_row.order_item_id IS NULL OR actual_supplier IS NULL
    OR actual_order IS DISTINCT FROM packet_row.order_id OR actual_org IS DISTINCT FROM packet_row.organization_id
    OR fulfillment_row.assigned_admin_id IS DISTINCT FROM NEW.assigned_admin_id
    OR (fulfillment_row.state <> 'READY_FOR_HANDOFF' AND NOT (fulfillment_row.state = 'HANDOFF_PENDING' AND fulfillment_row.handed_off_at IS NOT NULL AND public.gphkm_supplier_packet_retry_eligible(NEW.order_item_id, NEW.packet_id)))
    OR actual_supplier IS DISTINCT FROM packet_row.supplier_id
    OR actual_route_generation IS DISTINCT FROM NEW.route_generation
    OR actual_recipient IS NULL OR actual_recipient IS DISTINCT FROM lower(btrim(packet_row.recipient))
    OR packet_item_count <> 1 OR packet_item->>'assignedAdminId' IS DISTINCT FROM NEW.assigned_admin_id
    OR packet_item#>>'{consent,disclosureVersion}' IS DISTINCT FROM NEW.consent_notice_version
    OR packet_item#>>'{consent,contentHash}' IS DISTINCT FROM NEW.consent_content_hash
    OR packet_item#>>'{consent,supplierId}' IS DISTINCT FROM packet_row.supplier_id
    OR lower(btrim(packet_item#>>'{consent,recipient}')) IS DISTINCT FROM lower(btrim(packet_row.recipient))
    OR packet_item#>>'{consent,acceptedAt}' IS DISTINCT FROM to_char(NEW.consented_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') THEN
    RAISE EXCEPTION 'packet item does not match the order-time fulfillment snapshot' USING ERRCODE = '23514';
  END IF;

  SELECT item_row.supplier_sharing_consented
    AND item_row.consent_notice_version = NEW.consent_notice_version
    AND item_row.consented_at = NEW.consented_at
    AND packet_item#>>'{consent,consentEventId}' IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.order_item_content_version version WHERE version.order_item_id = item_row.id)
    AND EXISTS (SELECT 1 FROM public.order_item_supplier_consent consent
      WHERE consent.order_item_id = item_row.id AND consent.supplier_id = packet_row.supplier_id
        AND lower(btrim(consent.recipient_email)) = lower(btrim(packet_row.recipient))
        AND consent.notice_version = NEW.consent_notice_version AND consent.accepted_at = NEW.consented_at)
    AND packet_item->'placementRequirements' IS NOT DISTINCT FROM
      public.gphkm_packet_placement_requirements(item_row.customer_listing_snapshot)
    AND packet_item->>'targetUrl' = item_row.target_url
    AND packet_item->>'anchorText' = item_row.anchor_text
    AND packet_item->>'instructions' = btrim(coalesce(item_row.instructions, ''))
    AND packet_item->>'article' = CASE WHEN item_row.writing_selected
      THEN (SELECT writing.approved_article_text FROM public.order_item_writing writing WHERE writing.order_item_id = item_row.id)
      ELSE item_row.article_text END
    AND NOT EXISTS (
      SELECT 1 FROM public.order_item_content_change_request request
      JOIN LATERAL (SELECT event.event_type FROM public.order_item_content_change_event event
        WHERE event.request_id = request.id ORDER BY event.created_at DESC, event.id DESC LIMIT 1) latest ON true
       WHERE request.order_item_id = item_row.id AND latest.event_type IN ('REQUESTED', 'APPROVED')
    ) INTO valid_base_consent;

  SELECT item_row.supplier_sharing_consented
    AND packet_item#>>'{consent,consentEventId}' IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.order_item_content_change_event event
        JOIN public.order_item_content_version version ON version.id = event.version_id AND version.request_id = event.request_id
        JOIN public.order_item_content_change_request request ON request.id = event.request_id
        LEFT JOIN public.order_item_writing writing ON writing.order_item_id = item_row.id
       WHERE event.id = packet_item#>>'{consent,consentEventId}'
         AND event.event_type = 'CONSENTED' AND event.version_id = version.id
         AND event.content_hash = version.content_hash AND event.notice_version = NEW.consent_notice_version
         AND event.created_at = NEW.consented_at AND request.order_item_id = item_row.id
         AND (request.target_supplier_id IS NULL OR request.target_supplier_id = packet_row.supplier_id)
         AND version.order_item_id = item_row.id
         AND version.id = (SELECT latest.id FROM public.order_item_content_version latest
           WHERE latest.order_item_id = item_row.id ORDER BY latest.version DESC LIMIT 1)
         AND version.supplier_id = packet_row.supplier_id
         AND lower(btrim(version.recipient_email)) = lower(btrim(packet_row.recipient))
         AND packet_item->'placementRequirements' IS NOT DISTINCT FROM public.gphkm_packet_placement_requirements(coalesce(
           (SELECT offer.terms FROM public.order_item_equivalent_offer offer
              JOIN public.order_item_equivalent_offer_event accepted ON accepted.offer_id = offer.id
                AND accepted.event_type = 'ACCEPTED' AND accepted.content_hash = version.content_hash
             WHERE offer.content_request_id = request.id
             ORDER BY accepted.created_at DESC, accepted.id DESC LIMIT 1),
           item_row.customer_listing_snapshot))
         AND packet_item->>'targetUrl' = version.target_url
         AND packet_item->>'anchorText' = version.anchor_text
         AND packet_item->>'instructions' = version.instructions
         AND packet_item->>'article' = CASE
           WHEN item_row.writing_selected AND writing.state IN ('APPROVED_FIRST', 'APPROVED_FINAL') THEN writing.approved_article_text
           WHEN item_row.writing_selected AND writing.state = 'CUSTOMER_DECLINED_FINAL' THEN coalesce(version.article_text, item_row.article_text)
           WHEN NOT item_row.writing_selected THEN coalesce(version.article_text, item_row.article_text)
           ELSE NULL
         END
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.order_item_content_change_request request
      JOIN LATERAL (SELECT event.event_type FROM public.order_item_content_change_event event
        WHERE event.request_id = request.id ORDER BY event.created_at DESC, event.id DESC LIMIT 1) latest ON true
       WHERE request.order_item_id = item_row.id AND latest.event_type IN ('REQUESTED', 'APPROVED')
    )
    AND (fulfillment_row.handed_off_at IS NULL
      OR EXISTS (SELECT 1 FROM public.order_item_content_change_event consent_event
        JOIN public.order_item_content_change_request consent_request ON consent_request.id = consent_event.request_id
        WHERE consent_event.id = packet_item#>>'{consent,consentEventId}' AND consent_event.event_type = 'CONSENTED'
          AND consent_request.purpose = 'RECIPIENT_RECONSENT')
      OR EXISTS (
        SELECT 1
          FROM public.order_item_content_change_event consent_event
          JOIN public.order_item_content_change_request consent_request ON consent_request.id = consent_event.request_id
          JOIN public.order_item_equivalent_offer offer ON offer.content_request_id = consent_request.id
            AND offer.content_version_id = consent_event.version_id AND offer.order_item_id = item_row.id
          JOIN public.order_item_equivalent_offer_route offered_route ON offered_route.offer_id = offer.id
          JOIN public.customer_order order_row ON order_row.id = item_row.order_id
          JOIN LATERAL (SELECT offer_event.event_type, offer_event.actor_user_id, offer_event.content_hash,
                               offer_event.notice_version
            FROM public.order_item_equivalent_offer_event offer_event WHERE offer_event.offer_id = offer.id
            ORDER BY offer_event.created_at DESC, offer_event.id DESC LIMIT 1) latest ON true
         WHERE consent_event.id = packet_item#>>'{consent,consentEventId}'
           AND consent_event.event_type = 'CONSENTED' AND consent_request.purpose = 'CONTENT_CHANGE'
           AND consent_request.target_supplier_id = packet_row.supplier_id
           AND offered_route.supplier_id = packet_row.supplier_id
           AND offered_route.route_generation = NEW.route_generation
           AND lower(btrim(offered_route.recipient_email)) = lower(btrim(packet_row.recipient))
           AND offered_route.content_hash = consent_event.content_hash
           AND latest.event_type = 'ACCEPTED' AND latest.actor_user_id = order_row.actor_user_id
           AND latest.content_hash = consent_event.content_hash AND latest.notice_version = consent_event.notice_version
           AND EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome
             WHERE outcome.order_item_id = item_row.id AND outcome.support_case_id = offer.support_case_id
               AND outcome.supplier_id IS DISTINCT FROM packet_row.supplier_id)
      )) INTO valid_version_consent;

  IF NOT coalesce(valid_base_consent, false) AND NOT coalesce(valid_version_consent, false) THEN
    RAISE EXCEPTION 'packet item does not match the order-time fulfillment snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_packet_item_guard() FROM PUBLIC;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_packet_attempt_route_generation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  packet_row public.supplier_packet%ROWTYPE;
  item_ref text;
  item_state text;
  item_handed_off_at timestamptz;
  item_route_supplier_id text;
  item_route_generation integer;
  retry_eligible boolean;
  accepted_equivalent_route boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.type NOT IN ('SEND','EML_EXPORT','PDF_EXPORT','MANUAL_SENT','MANUAL_SEND') THEN RETURN NEW; END IF;
  SELECT packet.* INTO packet_row FROM public.supplier_packet packet WHERE packet.id = NEW.packet_id FOR UPDATE;
  IF NOT FOUND OR packet_row.superseded_at IS NOT NULL OR packet_row.hold_reason IS NOT NULL THEN
    RAISE EXCEPTION 'supplier packet is superseded, held, or unavailable' USING ERRCODE = '42501';
  END IF;

  FOR item_ref IN
    SELECT packet_item.order_item_id FROM public.supplier_packet_item packet_item
     WHERE packet_item.packet_id = NEW.packet_id ORDER BY packet_item.order_item_id
  LOOP
    SELECT fulfillment.state, fulfillment.handed_off_at INTO item_state, item_handed_off_at
      FROM public.order_item_fulfillment fulfillment
     WHERE fulfillment.order_item_id = item_ref FOR UPDATE;
    IF item_state NOT IN ('HANDOFF_PENDING', 'IN_FULFILLMENT') THEN
      RAISE EXCEPTION 'supplier packet attempts require an active handoff item' USING ERRCODE = '42501';
    END IF;
    SELECT route.supplier_id, route.route_generation INTO item_route_supplier_id, item_route_generation
      FROM public.order_item_fulfillment_supplier route
     WHERE route.order_item_id = item_ref FOR KEY SHARE;
    retry_eligible := public.gphkm_supplier_packet_retry_eligible(item_ref, NEW.packet_id);
    SELECT EXISTS (
      SELECT 1 FROM public.supplier_fulfillment_outcome outcome
      JOIN public.supplier_fulfillment_outcome_resolution resolution ON resolution.outcome_id = outcome.id
      JOIN public.order_item_equivalent_offer offer ON offer.id = resolution.offer_id
      JOIN public.order_item_equivalent_offer_route offered_route ON offered_route.offer_id = offer.id
      JOIN public.customer_order_item item ON item.id = offer.order_item_id
      JOIN public.customer_order order_row ON order_row.id = item.order_id
      JOIN LATERAL (SELECT event.event_type, event.actor_user_id FROM public.order_item_equivalent_offer_event event
        WHERE event.offer_id = offer.id ORDER BY event.created_at DESC, event.id DESC LIMIT 1) latest ON true
      WHERE outcome.order_item_id = item_ref AND outcome.supplier_id IS DISTINCT FROM packet_row.supplier_id
        AND offer.order_item_id = item_ref AND offered_route.supplier_id = packet_row.supplier_id
        AND offered_route.route_generation = item_route_generation
        AND latest.event_type = 'ACCEPTED' AND latest.actor_user_id = order_row.actor_user_id
    ) INTO accepted_equivalent_route;
    IF item_handed_off_at IS NOT NULL AND (
      (retry_eligible AND NEW.type <> 'SEND')
      OR (NOT retry_eligible AND NOT accepted_equivalent_route)
    ) THEN
      RAISE EXCEPTION 'post-cutoff retry requires fresh consent and a Resend delivery attempt' USING ERRCODE = '42501';
    END IF;
    IF item_route_supplier_id IS DISTINCT FROM packet_row.supplier_id OR NOT EXISTS (
      SELECT 1 FROM public.supplier_packet_item packet_item
      JOIN public.supplier_packet packet ON packet.id = packet_item.packet_id
      JOIN public.supplier_contact contact ON contact.supplier_id = packet.supplier_id AND contact.is_primary
       WHERE packet_item.packet_id = NEW.packet_id AND packet_item.order_item_id = item_ref
         AND packet_item.route_generation = item_route_generation
         AND packet.version = (SELECT max(latest.version)
           FROM public.supplier_packet latest
           JOIN public.supplier_packet_item latest_item ON latest_item.packet_id = latest.id
           WHERE latest_item.order_item_id = item_ref AND latest_item.route_generation = item_route_generation
             AND latest.supplier_id = item_route_supplier_id AND latest.superseded_at IS NULL AND latest.hold_reason IS NULL)
         AND lower(contact.email) = lower(packet.recipient)
    ) THEN
      RAISE EXCEPTION 'supplier packet route, recipient, or active version is stale' USING ERRCODE = '42501';
    END IF;
    IF NOT public.gphkm_supplier_packet_item_consent_is_current(NEW.packet_id, item_ref) THEN
      RAISE EXCEPTION 'supplier packet recipient or content consent is unavailable or stale' USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.supplier_fulfillment_outcome outcome
       WHERE outcome.order_item_id = item_ref
         AND NOT EXISTS (
           SELECT 1 FROM public.supplier_fulfillment_outcome_resolution resolution
            WHERE resolution.outcome_id = outcome.id
              AND (
                (resolution.offer_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM public.order_item_equivalent_offer offer
                  JOIN public.order_item_equivalent_offer_route offer_route ON offer_route.offer_id = offer.id
                  JOIN public.customer_order_item item ON item.id = offer.order_item_id
                  JOIN public.customer_order order_row ON order_row.id = item.order_id
                  JOIN LATERAL (
                    SELECT event.event_type, event.actor_user_id
                      FROM public.order_item_equivalent_offer_event event
                     WHERE event.offer_id = offer.id ORDER BY event.created_at DESC, event.id DESC LIMIT 1
                  ) latest ON true
                  WHERE offer.id = resolution.offer_id AND offer.order_item_id = outcome.order_item_id
                    AND offer.support_case_id = outcome.support_case_id AND latest.event_type = 'ACCEPTED'
                    AND latest.actor_user_id = order_row.actor_user_id
                    AND offer_route.route_generation > outcome.route_generation
                    AND offer_route.route_generation <= item_route_generation
                ))
                OR (resolution.recovery_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM public.supplier_fulfillment_recovery recovery
                  WHERE recovery.id = resolution.recovery_id AND recovery.order_item_id = outcome.order_item_id
                    AND recovery.supplier_id = outcome.supplier_id
                    AND recovery.support_case_id = outcome.support_case_id
                    AND recovery.route_generation = outcome.route_generation
                    AND recovery.route_generation <= item_route_generation
                ))
              )
         )
    ) THEN
      RAISE EXCEPTION 'resolve the supplier failure through an accepted route or audited recovery before handoff' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.supplier_packet_item packet_item WHERE packet_item.packet_id = NEW.packet_id) THEN
    RAISE EXCEPTION 'supplier packet has no items' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_packet_attempt_route_generation_guard() FROM PUBLIC;
