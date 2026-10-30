-- Expose only a bounded operational refund count on supplier profiles.
CREATE FUNCTION public.gphkm_supplier_operational_refunded_count(target_supplier_id text, since_at timestamptz)
RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), '');
        bounded_since timestamptz;
        result_count bigint;
BEGIN
  IF actor_id IS NULL OR NOT (
    public.gphkm_is_active_staff(actor_id, 'ADMIN')
    OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')
  ) THEN
    RAISE EXCEPTION 'supplier operational refund count unavailable' USING ERRCODE = '42501';
  END IF;
  IF target_supplier_id IS NULL OR length(target_supplier_id) > 80 OR since_at IS NULL THEN
    RAISE EXCEPTION 'supplier operational refund count input invalid' USING ERRCODE = '22023';
  END IF;
  bounded_since := greatest(since_at, now() - interval '90 days');
  SELECT count(*)::bigint INTO result_count
    FROM (
      SELECT ledger.related_id
        FROM public.wallet_ledger_entry ledger
        JOIN public.order_item_fulfillment_supplier route ON route.order_item_id = ledger.related_id
        JOIN public.customer_order_item item ON item.id = ledger.related_id
        JOIN public.customer_order customer_order ON customer_order.id = item.order_id
       WHERE route.supplier_id = target_supplier_id
         AND customer_order.checkout_state = 'PAID'
         AND customer_order.created_at >= bounded_since
         AND ledger.kind = 'ITEM_REFUND'
         AND ledger.related_type = 'CUSTOMER_ORDER_ITEM'
       GROUP BY ledger.related_id
      HAVING sum(ledger.delta_minor) > 0
    ) refunded_items;
  RETURN coalesce(result_count, 0);
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_operational_refunded_count(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_supplier_operational_refunded_count(text, timestamptz) TO gphkm_runtime;
