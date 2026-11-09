CREATE TABLE "order_item_supplier_consent" (
	"order_item_id" text PRIMARY KEY NOT NULL,
	"supplier_id" text NOT NULL,
	"recipient_email" text NOT NULL,
	"notice_version" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"capture_source" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_item_supplier_consent_email_valid" CHECK (length(btrim("order_item_supplier_consent"."recipient_email")) between 3 and 320 and "order_item_supplier_consent"."recipient_email" !~ '[[:cntrl:]]'),
	CONSTRAINT "order_item_supplier_consent_notice_valid" CHECK (length(btrim("order_item_supplier_consent"."notice_version")) between 1 and 80),
	CONSTRAINT "order_item_supplier_consent_source_valid" CHECK ("order_item_supplier_consent"."capture_source" in ('CHECKOUT_ROUTE', 'VERIFIED_HISTORIC_CONTACT'))
);
--> statement-breakpoint
ALTER TABLE "order_item_supplier_consent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_item_supplier_consent" ADD CONSTRAINT "order_item_supplier_consent_order_item_id_customer_order_item_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."customer_order_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_supplier_consent" ADD CONSTRAINT "order_item_supplier_consent_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- Keep the exact primary address used when checkout captured content-sharing
-- consent. This table has RLS but no runtime policies or grants; packet guards
-- read it through their SECURITY DEFINER owner only.
CREATE FUNCTION public.gphkm_capture_supplier_recipient_consent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  item_row public.customer_order_item%ROWTYPE;
  source_kind text;
  source_supplier text;
  recipient text;
BEGIN
  IF NEW.supplier_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO item_row FROM public.customer_order_item WHERE id = NEW.order_item_id;
  SELECT commercial_source, fulfillment_supplier_id INTO source_kind, source_supplier
    FROM public.order_item_financial WHERE order_item_id = NEW.order_item_id;
  IF item_row.id IS NULL OR NOT item_row.supplier_sharing_consented
    OR source_kind <> 'SUPPLIER_SOURCED' OR source_supplier IS DISTINCT FROM NEW.supplier_id THEN
    RAISE EXCEPTION 'supplier recipient consent source is unavailable' USING ERRCODE = '23514';
  END IF;

  SELECT contact.email INTO recipient
    FROM public.supplier supplier_row
    JOIN public.supplier_contact contact ON contact.supplier_id = supplier_row.id
   WHERE supplier_row.id = NEW.supplier_id AND supplier_row.status = 'ACTIVE' AND contact.is_primary
   FOR SHARE OF contact;
  IF recipient IS NULL THEN
    RAISE EXCEPTION 'active supplier primary contact is required at checkout' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.order_item_supplier_consent
    (order_item_id, supplier_id, recipient_email, notice_version, accepted_at, capture_source)
  VALUES (NEW.order_item_id, NEW.supplier_id, recipient, item_row.consent_notice_version,
    item_row.consented_at, 'CHECKOUT_ROUTE');
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_capture_supplier_recipient_consent() FROM PUBLIC, gphkm_runtime;
CREATE TRIGGER order_item_supplier_recipient_consent_capture
  AFTER INSERT ON public.order_item_fulfillment_supplier
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_capture_supplier_recipient_consent();
--> statement-breakpoint

-- Backfill only when the current primary contact row was already present and
-- untouched at checkout, and the route is still the original supplier route.
-- Rows without that evidence fail closed and need customer consent for a new
-- content version before packet preparation.
INSERT INTO public.order_item_supplier_consent
  (order_item_id, supplier_id, recipient_email, notice_version, accepted_at, capture_source, recorded_at)
SELECT item.id, route.supplier_id, contact.email, item.consent_notice_version, item.consented_at,
  'VERIFIED_HISTORIC_CONTACT', clock_timestamp()
  FROM public.customer_order_item item
  JOIN public.customer_order order_row ON order_row.id = item.order_id
  JOIN public.order_item_financial financial ON financial.order_item_id = item.id
  JOIN public.order_item_fulfillment_supplier route ON route.order_item_id = item.id
  JOIN public.supplier supplier_row ON supplier_row.id = route.supplier_id AND supplier_row.status = 'ACTIVE'
  JOIN public.supplier_contact contact ON contact.supplier_id = route.supplier_id AND contact.is_primary
 WHERE item.supplier_sharing_consented
   AND financial.commercial_source = 'SUPPLIER_SOURCED'
   AND financial.fulfillment_supplier_id = route.supplier_id
   AND route.route_generation = 1
   AND contact.created_at <= order_row.created_at
   AND contact.updated_at <= order_row.created_at
ON CONFLICT (order_item_id) DO NOTHING;
--> statement-breakpoint

CREATE FUNCTION public.gphkm_supplier_consent_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'supplier recipient consent snapshot is immutable' USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_consent_immutable() FROM PUBLIC;
CREATE TRIGGER order_item_supplier_consent_immutable
  BEFORE UPDATE OR DELETE ON public.order_item_supplier_consent
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_consent_immutable();
REVOKE ALL ON public.order_item_supplier_consent FROM PUBLIC, gphkm_runtime, gphkm_resend_webhook;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_packet_placement_requirements(snapshot jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  WITH parts AS (
    SELECT array_remove(ARRAY[
      CASE WHEN nullif(snapshot->>'linkType', '') IS NOT NULL THEN 'Link type: ' || (snapshot->>'linkType') END,
      CASE WHEN nullif(snapshot->>'linkValidity', '') IS NOT NULL THEN 'Placement term: ' || (snapshot->>'linkValidity') END,
      CASE WHEN snapshot->>'sponsoredContentMarking' = 'true' THEN 'Mark the article as sponsored content.' END,
      CASE WHEN nullif(btrim(snapshot->>'buyerRequirements'), '') IS NOT NULL THEN btrim(snapshot->>'buyerRequirements') END
    ]::text[], NULL) AS requirements
  )
  SELECT CASE WHEN cardinality(requirements) = 0
    THEN '["Follow the agreed publication requirements."]'::jsonb
    ELSE to_jsonb(requirements) END
    FROM parts
$$;
REVOKE ALL ON FUNCTION public.gphkm_packet_placement_requirements(jsonb) FROM PUBLIC;
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
    ) INTO valid_version_consent;

  IF NOT coalesce(valid_base_consent, false) AND NOT coalesce(valid_version_consent, false) THEN
    RAISE EXCEPTION 'packet item does not match the order-time fulfillment snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_packet_item_guard() FROM PUBLIC;
