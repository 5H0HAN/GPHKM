-- Permit the audited manual fallback only while the latest provider send for
-- this exact current packet still has an unresolved delivery outcome. Keep
-- recipient-reconsent retries on the Resend-only path and serialize manual
-- reservations through the packet row lock.
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
  latest_provider_state text;
  pending_provider_fallback boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.type NOT IN ('SEND','EML_EXPORT','PDF_EXPORT','MANUAL_SENT','MANUAL_SEND') THEN RETURN NEW; END IF;
  SELECT packet.* INTO packet_row FROM public.supplier_packet packet WHERE packet.id = NEW.packet_id FOR UPDATE;
  IF NOT FOUND OR packet_row.superseded_at IS NOT NULL OR packet_row.hold_reason IS NOT NULL THEN
    RAISE EXCEPTION 'supplier packet is superseded, held, or unavailable' USING ERRCODE = '42501';
  END IF;

  IF NEW.type = 'MANUAL_SEND' AND EXISTS (
    SELECT 1 FROM public.supplier_packet_attempt pending
     WHERE pending.packet_id = NEW.packet_id AND pending.type = 'MANUAL_SEND' AND pending.state = 'SENDING'
  ) THEN
    RAISE EXCEPTION 'a manual handoff is already in progress' USING ERRCODE = '42501';
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

    pending_provider_fallback := false;
    IF NEW.type = 'MANUAL_SEND' AND NOT retry_eligible THEN
      SELECT attempt.state INTO latest_provider_state
        FROM public.supplier_packet_attempt attempt
       WHERE attempt.packet_id = NEW.packet_id AND attempt.type = 'SEND'
       ORDER BY attempt.created_at DESC, attempt.id DESC LIMIT 1;
      pending_provider_fallback := coalesce(latest_provider_state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERY_ISSUE'), false);
    END IF;

    IF item_handed_off_at IS NOT NULL AND (
      (retry_eligible AND NEW.type <> 'SEND')
      OR (NOT retry_eligible AND NOT accepted_equivalent_route AND NOT pending_provider_fallback)
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_packet_attempt_route_generation_guard() FROM PUBLIC;
