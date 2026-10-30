-- Refund reporting exposes only item-level aggregates to active Super Admins.
CREATE FUNCTION public.gphkm_supplier_item_refund_totals()
RETURNS TABLE(order_item_id text, refunded_minor numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'supplier refund report unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT l.related_id, sum(l.delta_minor)::numeric
    FROM public.wallet_ledger_entry l
    JOIN public.order_item_fulfillment_supplier fs ON fs.order_item_id = l.related_id
    WHERE l.kind = 'ITEM_REFUND' AND l.related_type = 'CUSTOMER_ORDER_ITEM'
    GROUP BY l.related_id;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_item_refund_totals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_supplier_item_refund_totals() TO gphkm_runtime;
