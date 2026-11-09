-- Preserve consent checks for pre-event packet snapshots whose JS Date timestamp stored milliseconds.
CREATE OR REPLACE FUNCTION public.gphkm_supplier_packet_item_consent_is_current(target_packet_id text, target_item_id text) RETURNS boolean
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
    OR NOT (
      packet_item#>>'{consent,acceptedAt}' IS NOT DISTINCT FROM
        to_char(membership_row.consented_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      OR (
        NOT (packet_item->'consent' ? 'consentEventId')
        AND packet_item#>>'{consent,acceptedAt}' IS NOT DISTINCT FROM
          to_char(membership_row.consented_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    ) THEN
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
       WHERE request.order_item_id = item_row.id
         AND request.request_number = (SELECT max(current_request.request_number)
           FROM public.order_item_content_change_request current_request
          WHERE current_request.order_item_id = item_row.id)
         AND latest.event_type IN ('REQUESTED', 'APPROVED')
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
       WHERE request.order_item_id = item_row.id
         AND request.request_number = (SELECT max(current_request.request_number)
           FROM public.order_item_content_change_request current_request
          WHERE current_request.order_item_id = item_row.id)
         AND latest.event_type IN ('REQUESTED', 'APPROVED')
    ) INTO valid_version_consent;

  RETURN coalesce(valid_base_consent, false) OR coalesce(valid_version_consent, false);
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_packet_item_consent_is_current(text, text) FROM PUBLIC;
--> statement-breakpoint
