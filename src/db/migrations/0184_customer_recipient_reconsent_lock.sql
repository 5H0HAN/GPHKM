-- Custom SQL migration file, put your code below! --
-- Customer RLS intentionally hides supplier routing. Serialize recipient-bound
-- re-consent without returning supplier identifiers or contact details.
CREATE OR REPLACE FUNCTION public.gphkm_lock_customer_recipient_reconsent(target_request_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  active_org_id text := nullif(current_setting('app.organization_id', true), '');
  request_item_id text;
  item_order_id text;
  order_actor_id text;
  order_org_id text;
  locked_supplier_id text;
  current_supplier_id text;
BEGIN
  IF actor_id IS NULL OR active_org_id IS NULL THEN
    RAISE EXCEPTION 'recipient consent is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT request.order_item_id, item.order_id, order_row.actor_user_id, order_row.organization_id
    INTO request_item_id, item_order_id, order_actor_id, order_org_id
    FROM public.order_item_content_change_request request
    JOIN public.customer_order_item item ON item.id = request.order_item_id
    JOIN public.customer_order order_row ON order_row.id = item.order_id
   WHERE request.id = target_request_id
     AND request.purpose = 'RECIPIENT_RECONSENT'
     AND request.requested_by_user_id = actor_id;

  IF NOT FOUND OR order_actor_id IS DISTINCT FROM actor_id
     OR order_org_id IS DISTINCT FROM active_org_id
     OR NOT public.gphkm_is_active_org_member(active_org_id, actor_id) THEN
    RAISE EXCEPTION 'recipient consent is unavailable' USING ERRCODE = '42501';
  END IF;

  -- Keep the same lock order used by packet preparation and the consent guard.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('supplier_packet_prepare:' || item_order_id, 0::bigint));
  SELECT route.supplier_id INTO locked_supplier_id
    FROM public.order_item_fulfillment_supplier route
   WHERE route.order_item_id = request_item_id;
  IF locked_supplier_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('gphkm:supplier-contact:' || locked_supplier_id, 0::bigint));
  END IF;

  SELECT route.supplier_id INTO current_supplier_id
    FROM public.order_item_fulfillment_supplier route
   WHERE route.order_item_id = request_item_id
   FOR KEY SHARE OF route;
  IF current_supplier_id IS DISTINCT FROM locked_supplier_id THEN
    RAISE EXCEPTION 'supplier route changed during content consent' USING ERRCODE = '40001';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_lock_customer_recipient_reconsent(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_lock_customer_recipient_reconsent(text) TO gphkm_runtime;
