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

  -- Item locks are the serialization point shared by route mutations and packet preparation.
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

  SELECT count(*)
    INTO packet_item_count
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(packet_row.packet->'items') = 'array'
        THEN packet_row.packet->'items' ELSE '[]'::jsonb END
    ) candidate
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
    OR fulfillment_row.state <> 'READY_FOR_HANDOFF'
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
    AND NOT EXISTS (SELECT 1 FROM public.order_item_content_version version
      WHERE version.order_item_id = item_row.id)
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
    )
    INTO valid_base_consent;

  SELECT item_row.supplier_sharing_consented
    AND packet_item#>>'{consent,consentEventId}' IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.order_item_content_change_event event
        JOIN public.order_item_content_version version ON version.id = event.version_id
          AND version.request_id = event.request_id
        JOIN public.order_item_content_change_request request ON request.id = event.request_id
        LEFT JOIN public.order_item_writing writing ON writing.order_item_id = item_row.id
       WHERE event.id = packet_item#>>'{consent,consentEventId}'
         AND event.event_type = 'CONSENTED'
         AND event.version_id = version.id
         AND event.content_hash = version.content_hash
         AND event.notice_version = NEW.consent_notice_version
         AND event.created_at = NEW.consented_at
         AND request.order_item_id = item_row.id
         AND request.target_supplier_id = packet_row.supplier_id
         AND version.order_item_id = item_row.id
         AND version.id = (SELECT latest.id FROM public.order_item_content_version latest
           WHERE latest.order_item_id = item_row.id ORDER BY latest.version DESC LIMIT 1)
         AND version.supplier_id = packet_row.supplier_id
         AND lower(btrim(version.recipient_email)) = lower(btrim(packet_row.recipient))
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
    INTO valid_version_consent;

  IF NOT coalesce(valid_base_consent, false) AND NOT coalesce(valid_version_consent, false) THEN
    RAISE EXCEPTION 'packet item does not match the order-time fulfillment snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_packet_item_guard() FROM PUBLIC;
