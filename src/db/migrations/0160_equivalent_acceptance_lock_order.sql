-- Acceptance can be called directly by the restricted runtime role. Lock the
-- fulfillment item before re-reading or changing its supplier route, matching
-- work-start's item-then-route order.
CREATE OR REPLACE FUNCTION public.gphkm_apply_equivalent_offer_acceptance(target_offer_id text, target_user_id text, target_org_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE item_id text; next_supplier text; next_recipient text; request_id text; version_id text; content_digest text;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
BEGIN
  IF target_user_id IS NULL OR target_user_id <> nullif(current_setting('app.user_id',true),'')
    OR target_org_id <> nullif(current_setting('app.organization_id',true),'') THEN
    RAISE EXCEPTION 'equivalent offer unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT o.order_item_id INTO item_id
    FROM public.order_item_equivalent_offer o
    JOIN public.customer_order_item i ON i.id = o.order_item_id
    JOIN public.customer_order ord ON ord.id = i.order_id
   WHERE o.id = target_offer_id AND ord.organization_id = target_org_id
     AND ord.actor_user_id = target_user_id
     AND public.gphkm_is_active_org_member(target_org_id, target_user_id)
     AND EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_event e
       WHERE e.offer_id = o.id AND e.event_type = 'ACCEPTED' AND e.actor_user_id = target_user_id)
     AND NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_event e
       WHERE e.offer_id = o.id AND e.event_type = 'DECLINED');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'equivalent offer unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT f.* INTO fulfillment_row
    FROM public.order_item_fulfillment f
   WHERE f.order_item_id = item_id
   FOR UPDATE;
  IF NOT FOUND OR fulfillment_row.handed_off_at IS NOT NULL OR fulfillment_row.work_started_at IS NOT NULL
    OR fulfillment_row.state IN ('IN_FULFILLMENT','PUBLICATION_PENDING','EVIDENCE_REVIEW','COMPLETED','CANCELED_REFUNDED') THEN
    RAISE EXCEPTION 'equivalent offer is closed after handoff' USING ERRCODE = '42501';
  END IF;

  -- Re-read consent and the supplier route only after taking the item lock.
  SELECT o.order_item_id, r.supplier_id, r.recipient_email, o.content_request_id, o.content_version_id, r.content_hash
    INTO item_id, next_supplier, next_recipient, request_id, version_id, content_digest
    FROM public.order_item_equivalent_offer o
    JOIN public.order_item_equivalent_offer_route r ON r.offer_id = o.id
    JOIN public.customer_order_item i ON i.id = o.order_item_id
    JOIN public.customer_order ord ON ord.id = i.order_id
   WHERE o.id = target_offer_id AND ord.organization_id = target_org_id
     AND ord.actor_user_id = target_user_id
     AND public.gphkm_is_active_org_member(target_org_id, target_user_id)
     AND EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_event e
       WHERE e.offer_id = o.id AND e.event_type = 'ACCEPTED'
         AND e.actor_user_id = target_user_id AND e.content_hash = r.content_hash)
     AND NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_event e
       WHERE e.offer_id = o.id AND e.event_type = 'DECLINED');
  IF NOT FOUND
    OR NOT EXISTS (SELECT 1 FROM public.order_item_content_change_event e
      WHERE e.request_id = request_id AND e.event_type = 'CONSENTED'
        AND e.version_id = version_id AND e.content_hash = content_digest AND e.actor_user_id = target_user_id)
    OR NOT EXISTS (SELECT 1 FROM public.supplier_contact c
      WHERE c.supplier_id = next_supplier AND c.is_primary AND lower(c.email) = lower(next_recipient)) THEN
    RAISE EXCEPTION 'equivalent offer consent or route is unavailable' USING ERRCODE = '42501';
  END IF;

  UPDATE public.order_item_fulfillment_supplier SET supplier_id = next_supplier WHERE order_item_id = item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'equivalent offer route is unavailable' USING ERRCODE = '42501'; END IF;
  UPDATE public.order_item_fulfillment SET state = 'READY_FOR_HANDOFF', state_before_hold = NULL,
    customer_status = 'PREPARING', updated_at = clock_timestamp() WHERE order_item_id = item_id;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_apply_equivalent_offer_acceptance(text,text,text) FROM PUBLIC;

-- A shared route lock conflicts with supplier reassignment while work starts;
-- both commands have already locked the item, so they share one lock order.
CREATE OR REPLACE FUNCTION public.gphkm_require_persisted_supplier_handoff() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE fulfillment_supplier_id text;
BEGIN
  IF NOT (
    (NEW.state = 'IN_FULFILLMENT' AND OLD.state IS DISTINCT FROM NEW.state)
    OR (NEW.work_started_at IS NOT NULL AND OLD.work_started_at IS DISTINCT FROM NEW.work_started_at)
  ) THEN RETURN NEW; END IF;

  SELECT fs.supplier_id INTO fulfillment_supplier_id
    FROM public.order_item_fulfillment_supplier fs
    WHERE fs.order_item_id = NEW.order_item_id
    FOR SHARE OF fs;
  IF fulfillment_supplier_id IS NULL THEN RETURN NEW; END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.supplier_packet_item pi
      JOIN public.supplier_packet packet ON packet.id = pi.packet_id
      JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = packet.id
     WHERE pi.order_item_id = NEW.order_item_id
       AND packet.supplier_id = fulfillment_supplier_id
       AND packet.superseded_at IS NULL
       AND packet.version = (
         SELECT max(latest.version)
           FROM public.supplier_packet latest
           JOIN public.supplier_packet_item latest_item ON latest_item.packet_id = latest.id
          WHERE latest_item.order_item_id = NEW.order_item_id
            AND latest.supplier_id = fulfillment_supplier_id
            AND latest.superseded_at IS NULL
       )
       AND (
         (attempt.type = 'SEND' AND attempt.state = 'DELIVERED' AND attempt.delivered_at IS NOT NULL)
         OR (attempt.type IN ('MANUAL_SENT','MANUAL_SEND') AND attempt.state = 'MANUAL_SENT' AND attempt.sent_at IS NOT NULL)
       )
  ) THEN
    RAISE EXCEPTION 'supplier placement requires delivery or manual handoff evidence for the current packet' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_require_persisted_supplier_handoff() FROM PUBLIC;
