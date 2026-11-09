-- Preserve accepted equivalent-route consent and restrict only same-supplier post-cutoff retries.
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
--> statement-breakpoint
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_packet_attempt_route_generation_guard() FROM PUBLIC;
