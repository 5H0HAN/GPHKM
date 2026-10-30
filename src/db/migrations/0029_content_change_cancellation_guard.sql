-- Cancellation review and content change requests share the same item lifecycle.
-- Enforce the application rule again at the RLS predicate and trigger boundary.
CREATE OR REPLACE FUNCTION public.gphkm_change_request_before_handoff(target_item_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.order_item_fulfillment f
    WHERE f.order_item_id = target_item_id
      AND f.handed_off_at IS NULL
      AND f.state NOT IN (
        'IN_FULFILLMENT', 'PUBLICATION_PENDING', 'EVIDENCE_REVIEW',
        'COMPLETED', 'CANCELED_REFUNDED', 'CANCELLATION_REQUESTED'
      )
  )
$$;

CREATE OR REPLACE FUNCTION public.gphkm_validate_content_change_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE fulfillment_row public.order_item_fulfillment%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.customer_order_item oi WHERE oi.id = NEW.order_item_id) THEN
    RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO fulfillment_row
  FROM public.order_item_fulfillment f
  WHERE f.order_item_id = NEW.order_item_id
  FOR UPDATE;

  IF NOT FOUND OR fulfillment_row.handed_off_at IS NOT NULL OR fulfillment_row.state IN (
    'IN_FULFILLMENT', 'PUBLICATION_PENDING', 'EVIDENCE_REVIEW',
    'COMPLETED', 'CANCELED_REFUNDED', 'CANCELLATION_REQUESTED'
  ) THEN
    RAISE EXCEPTION 'content changes close after handoff or when cancellation is pending' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
