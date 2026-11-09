-- Keep equivalent offers available when a new unresolved failure follows same-supplier recovery.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.gphkm_block_equivalent_offer_after_recovery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.event_type = 'OFFERED' AND NOT EXISTS (
    SELECT 1 FROM public.order_item_equivalent_offer offer
    JOIN public.order_item_fulfillment_supplier route ON route.order_item_id = offer.order_item_id
    JOIN public.supplier_fulfillment_outcome outcome ON outcome.order_item_id = offer.order_item_id
      AND outcome.support_case_id = offer.support_case_id
      AND outcome.supplier_id = route.supplier_id
      AND outcome.route_generation = route.route_generation
    WHERE offer.id = NEW.offer_id
      AND NOT EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome_resolution resolution
        WHERE resolution.outcome_id = outcome.id)
  ) THEN
    RAISE EXCEPTION 'cannot offer a replacement after the current supplier failure has been resolved' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_block_equivalent_offer_after_recovery() FROM PUBLIC;
--> statement-breakpoint
-- Enforce elevated re-consent actions using persisted staff authority, not a request-local role GUC.
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
       OR NOT public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
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
REVOKE ALL ON FUNCTION public.gphkm_validate_content_change_request() FROM PUBLIC;
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
     AND NOT public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN') THEN
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
REVOKE ALL ON FUNCTION public.gphkm_validate_content_change_event_binding() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.gphkm_validate_recipient_reconsent_version() RETURNS trigger
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
  IF NOT public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
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
       WHERE version.order_item_id = NEW.order_item_id), 1) + 1
     OR NOT public.gphkm_supplier_packet_retry_eligible(NEW.order_item_id, NULL) THEN
    RAISE EXCEPTION 'recipient re-consent version must preserve the approved packet content and bind the current recipient' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_validate_recipient_reconsent_version() FROM PUBLIC;
--> statement-breakpoint
-- Keep a current, exact recipient consent projection visible after packet preparation closes retries.
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
        AND (
          public.gphkm_supplier_packet_retry_eligible(item.id, NULL)
          OR EXISTS (SELECT 1 FROM public.order_item_content_change_event consent_event
            WHERE consent_event.request_id = request.id AND consent_event.event_type = 'CONSENTED'
              AND consent_event.actor_user_id = target_user_id
              AND consent_event.version_id = version_row.id
              AND consent_event.content_hash = version_row.content_hash)
        )))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_customer_approved_content(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_customer_approved_content(text, text, text) TO gphkm_runtime;
