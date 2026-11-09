-- Backfill externally fulfilled PLATFORM_OWNED rows too. A current primary
-- contact is accepted as historical evidence only when the contact row was
-- unchanged through checkout and the order still uses its original route.
INSERT INTO public.order_item_supplier_consent
  (order_item_id, supplier_id, recipient_email, notice_version, accepted_at, capture_source, recorded_at)
SELECT item.id, route.supplier_id, contact.email, item.consent_notice_version, item.consented_at,
  'VERIFIED_HISTORIC_CONTACT', clock_timestamp()
  FROM public.customer_order_item item
  JOIN public.customer_order order_row ON order_row.id = item.order_id
  JOIN public.order_item_financial financial ON financial.order_item_id = item.id
  JOIN public.order_item_fulfillment_supplier route ON route.order_item_id = item.id
  JOIN public.supplier_contact contact ON contact.supplier_id = route.supplier_id AND contact.is_primary
 WHERE item.supplier_sharing_consented
   AND financial.fulfillment_supplier_id = route.supplier_id
   AND route.route_generation = 1
   AND contact.created_at <= order_row.created_at
   AND contact.updated_at <= order_row.created_at
ON CONFLICT (order_item_id) DO NOTHING;
--> statement-breakpoint

-- Return only a boolean to the application; the immutable supplier email
-- snapshot itself stays private to SECURITY DEFINER guards.
CREATE FUNCTION public.gphkm_has_current_supplier_recipient_snapshot(target_item_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.order_item_supplier_consent consent
      JOIN public.customer_order_item item ON item.id = consent.order_item_id
      JOIN public.order_item_fulfillment_supplier route ON route.order_item_id = item.id
      JOIN public.supplier_contact contact ON contact.supplier_id = route.supplier_id AND contact.is_primary
     WHERE item.id = target_item_id
       AND item.supplier_sharing_consented
       AND route.supplier_id = consent.supplier_id
       AND lower(btrim(consent.recipient_email)) = lower(btrim(contact.email))
       AND consent.notice_version = item.consent_notice_version
       AND consent.accepted_at = item.consented_at
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_has_current_supplier_recipient_snapshot(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_has_current_supplier_recipient_snapshot(text) TO gphkm_runtime;
--> statement-breakpoint

-- Recheck the full packet consent at each export/send attempt. This protects
-- old packet rows as well as current rows from bypassing application loaders.
CREATE FUNCTION public.gphkm_supplier_packet_item_consent_is_current(target_packet_id text, target_item_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  packet_row public.supplier_packet%ROWTYPE;
  membership_row public.supplier_packet_item%ROWTYPE;
  item_row public.customer_order_item%ROWTYPE;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
  packet_item jsonb;
  packet_item_count integer;
  route_supplier_id text;
  route_generation integer;
  recipient_email text;
  actual_order_id text;
  actual_organization_id text;
  valid_base_consent boolean;
  valid_version_consent boolean;
BEGIN
  SELECT * INTO packet_row FROM public.supplier_packet packet WHERE packet.id = target_packet_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO membership_row FROM public.supplier_packet_item membership
   WHERE membership.packet_id = target_packet_id AND membership.order_item_id = target_item_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO item_row FROM public.customer_order_item item WHERE item.id = target_item_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment fulfillment
   WHERE fulfillment.order_item_id = target_item_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT route.supplier_id, route.route_generation, contact.email
    INTO route_supplier_id, route_generation, recipient_email
    FROM public.order_item_fulfillment_supplier route
    LEFT JOIN public.supplier_contact contact ON contact.supplier_id = route.supplier_id AND contact.is_primary
   WHERE route.order_item_id = target_item_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT order_row.id, order_row.organization_id INTO actual_order_id, actual_organization_id
    FROM public.customer_order_item item
    JOIN public.customer_order order_row ON order_row.id = item.order_id
   WHERE item.id = target_item_id;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT count(*) INTO packet_item_count
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(packet_row.packet->'items') = 'array'
      THEN packet_row.packet->'items' ELSE '[]'::jsonb END) candidate
   WHERE candidate->>'orderItemId' = target_item_id;
  IF packet_item_count = 1 THEN
    SELECT candidate INTO packet_item
      FROM jsonb_array_elements(packet_row.packet->'items') candidate
     WHERE candidate->>'orderItemId' = target_item_id;
  END IF;

  IF packet_row.packet->>'id' IS DISTINCT FROM packet_row.id
    OR packet_row.packet->>'orderId' IS DISTINCT FROM packet_row.order_id
    OR packet_row.packet->>'organizationId' IS DISTINCT FROM packet_row.organization_id
    OR packet_row.packet->>'supplierId' IS DISTINCT FROM packet_row.supplier_id
    OR lower(btrim(packet_row.packet->>'recipient')) IS DISTINCT FROM lower(btrim(packet_row.recipient))
    OR packet_row.order_id IS DISTINCT FROM actual_order_id
    OR packet_row.organization_id IS DISTINCT FROM actual_organization_id
    OR route_supplier_id IS DISTINCT FROM packet_row.supplier_id
    OR route_generation IS DISTINCT FROM membership_row.route_generation
    OR lower(btrim(recipient_email)) IS DISTINCT FROM lower(btrim(packet_row.recipient))
    OR membership_row.assigned_admin_id IS DISTINCT FROM fulfillment_row.assigned_admin_id
    OR fulfillment_row.state NOT IN ('HANDOFF_PENDING', 'IN_FULFILLMENT')
    OR packet_item_count <> 1
    OR packet_item->>'assignedAdminId' IS DISTINCT FROM membership_row.assigned_admin_id
    OR packet_item#>>'{consent,disclosureVersion}' IS DISTINCT FROM membership_row.consent_notice_version
    OR packet_item#>>'{consent,contentHash}' IS DISTINCT FROM membership_row.consent_content_hash
    OR packet_item#>>'{consent,supplierId}' IS DISTINCT FROM packet_row.supplier_id
    OR lower(btrim(packet_item#>>'{consent,recipient}')) IS DISTINCT FROM lower(btrim(packet_row.recipient))
    OR packet_item#>>'{consent,acceptedAt}' IS DISTINCT FROM
       to_char(membership_row.consented_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') THEN
    RETURN false;
  END IF;

  SELECT item_row.supplier_sharing_consented
    AND item_row.consent_notice_version = membership_row.consent_notice_version
    AND item_row.consented_at = membership_row.consented_at
    AND packet_item#>>'{consent,consentEventId}' IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.order_item_content_version version WHERE version.order_item_id = item_row.id)
    AND public.gphkm_has_current_supplier_recipient_snapshot(item_row.id)
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
         AND event.content_hash = version.content_hash AND event.notice_version = membership_row.consent_notice_version
         AND event.created_at = membership_row.consented_at AND request.order_item_id = item_row.id
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
    ) INTO valid_version_consent;

  RETURN coalesce(valid_base_consent, false) OR coalesce(valid_version_consent, false);
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_packet_item_consent_is_current(text, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_packet_attempt_route_generation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  packet_row public.supplier_packet%ROWTYPE;
  item_ref text;
  item_state text;
  item_route_supplier_id text;
  item_route_generation integer;
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
    SELECT fulfillment.state INTO item_state
      FROM public.order_item_fulfillment fulfillment
     WHERE fulfillment.order_item_id = item_ref FOR UPDATE;
    IF item_state NOT IN ('HANDOFF_PENDING', 'IN_FULFILLMENT') THEN
      RAISE EXCEPTION 'supplier packet attempts require an active handoff item' USING ERRCODE = '42501';
    END IF;
    SELECT route.supplier_id, route.route_generation INTO item_route_supplier_id, item_route_generation
      FROM public.order_item_fulfillment_supplier route
     WHERE route.order_item_id = item_ref FOR KEY SHARE;
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
