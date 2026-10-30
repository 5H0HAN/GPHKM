-- The runtime role cannot SELECT FOR UPDATE on customer_order. Use the table owner
-- only for the narrow parent-state lock that serializes item inserts vs checkout.
DO $$
DECLARE order_owner name;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO order_owner
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'customer_order';
  IF current_user = 'gphkm_runtime' OR order_owner IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'order lock migration must run as the customer_order table owner';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.gphkm_lock_pending_order_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE checkout_state text; customer_status text;
BEGIN
  SELECT o.checkout_state, o.customer_status INTO checkout_state, customer_status
    FROM public.customer_order o WHERE o.id = NEW.order_id FOR UPDATE;
  IF NOT FOUND OR checkout_state <> 'PENDING_POST' OR customer_status <> 'ORDER_RECEIVED' THEN
    RAISE EXCEPTION 'order no longer accepts items' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_lock_pending_order_item() FROM PUBLIC;
