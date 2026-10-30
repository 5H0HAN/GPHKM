-- Serialize packet sends, customer cancellation, and content revisions on the item row.
CREATE OR REPLACE FUNCTION public.gphkm_change_request_before_handoff(target_item_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.order_item_fulfillment f
    WHERE f.order_item_id = target_item_id
      AND f.handed_off_at IS NULL
      AND f.state NOT IN ('IN_FULFILLMENT','PUBLICATION_PENDING','EVIDENCE_REVIEW','COMPLETED','CANCELED_REFUNDED','CANCELLATION_REQUESTED')
  ) AND NOT EXISTS (
    SELECT 1 FROM public.supplier_packet_item pi
    JOIN public.supplier_packet_attempt a ON a.packet_id = pi.packet_id
    WHERE pi.order_item_id = target_item_id
      AND a.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERED','DELIVERY_ISSUE','MANUAL_SENT')
  )
$$;

CREATE OR REPLACE FUNCTION public.gphkm_customer_can_request_item_cancellation(target_item_id text, target_user_id text, target_org_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_customer_can_read_order_item(target_item_id, target_user_id, target_org_id)
    AND EXISTS (
      SELECT 1 FROM public.customer_order_item i JOIN public.customer_order o ON o.id = i.order_id
      JOIN public.order_item_fulfillment f ON f.order_item_id = i.id
      WHERE i.id = target_item_id AND o.organization_id = target_org_id AND o.checkout_state = 'PAID'
        AND f.state IN ('CONFIRMED','CONTENT_PREPARATION','AWAITING_CUSTOMER_APPROVAL','READY_FOR_HANDOFF','HANDOFF_PENDING')
        AND f.handed_off_at IS NULL AND f.work_started_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.supplier_packet_item pi JOIN public.supplier_packet_attempt a ON a.packet_id = pi.packet_id
      WHERE pi.order_item_id = target_item_id AND a.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERED','DELIVERY_ISSUE','MANUAL_SENT')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.order_item_content_change_request r
      JOIN LATERAL (SELECT e.event_type FROM public.order_item_content_change_event e
        WHERE e.request_id = r.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) latest ON true
      WHERE r.order_item_id = target_item_id AND latest.event_type IN ('REQUESTED','APPROVED')
    )
$$;

CREATE FUNCTION public.gphkm_reject_cancellation_with_pending_content_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.state = 'CANCELLATION_REQUESTED' AND OLD.state IS DISTINCT FROM NEW.state AND EXISTS (
    SELECT 1 FROM public.order_item_content_change_request r
    JOIN LATERAL (
      SELECT e.event_type FROM public.order_item_content_change_event e
      WHERE e.request_id = r.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1
    ) latest ON true
    WHERE r.order_item_id = NEW.order_item_id AND latest.event_type IN ('REQUESTED','APPROVED')
  ) THEN
    RAISE EXCEPTION 'resolve the pending content change before requesting cancellation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_cancellation_with_pending_content_change() FROM PUBLIC;
CREATE TRIGGER fulfillment_cancellation_requires_resolved_content
  BEFORE UPDATE OF state ON public.order_item_fulfillment
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_cancellation_with_pending_content_change();
