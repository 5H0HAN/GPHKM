-- Keep PL/pgSQL variables distinct from column names to avoid ambiguous SQL.
CREATE OR REPLACE FUNCTION public.gphkm_apply_equivalent_offer_acceptance(target_offer_id text, target_user_id text, target_org_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_item_id text; v_next_supplier text; v_next_recipient text; v_request_id text; v_version_id text; v_content_digest text;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
BEGIN
  IF target_user_id IS NULL OR target_user_id <> nullif(current_setting('app.user_id',true),'')
    OR target_org_id <> nullif(current_setting('app.organization_id',true),'') THEN
    RAISE EXCEPTION 'equivalent offer unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT o.order_item_id INTO v_item_id
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
   WHERE f.order_item_id = v_item_id
   FOR UPDATE;
  IF NOT FOUND OR fulfillment_row.handed_off_at IS NOT NULL OR fulfillment_row.work_started_at IS NOT NULL
    OR fulfillment_row.state IN ('IN_FULFILLMENT','PUBLICATION_PENDING','EVIDENCE_REVIEW','COMPLETED','CANCELED_REFUNDED') THEN
    RAISE EXCEPTION 'equivalent offer is closed after handoff' USING ERRCODE = '42501';
  END IF;

  -- Re-read consent and the supplier route only after taking the item lock.
  SELECT o.order_item_id, r.supplier_id, r.recipient_email, o.content_request_id, o.content_version_id, r.content_hash
    INTO v_item_id, v_next_supplier, v_next_recipient, v_request_id, v_version_id, v_content_digest
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
      WHERE e.request_id = v_request_id AND e.event_type = 'CONSENTED'
        AND e.version_id = v_version_id AND e.content_hash = v_content_digest AND e.actor_user_id = target_user_id)
    OR NOT EXISTS (SELECT 1 FROM public.supplier_contact c
      WHERE c.supplier_id = v_next_supplier AND c.is_primary AND lower(c.email) = lower(v_next_recipient)) THEN
    RAISE EXCEPTION 'equivalent offer consent or route is unavailable' USING ERRCODE = '42501';
  END IF;

  UPDATE public.order_item_fulfillment_supplier SET supplier_id = v_next_supplier WHERE order_item_id = v_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'equivalent offer route is unavailable' USING ERRCODE = '42501'; END IF;
  UPDATE public.order_item_fulfillment SET state = 'READY_FOR_HANDOFF', state_before_hold = NULL,
    customer_status = 'PREPARING', updated_at = clock_timestamp() WHERE order_item_id = v_item_id;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_apply_equivalent_offer_acceptance(text,text,text) FROM PUBLIC;
