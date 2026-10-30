-- Scope the definer-trigger's lock before RLS checks the inserted item.
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
DECLARE checkout_state text; customer_status text; actor_user text; org_id text;
BEGIN
  actor_user := nullif(current_setting('app.user_id', true), '');
  org_id := nullif(current_setting('app.organization_id', true), '');
  SELECT o.checkout_state, o.customer_status INTO checkout_state, customer_status
    FROM public.customer_order o
   WHERE o.id = NEW.order_id AND o.organization_id = org_id AND o.actor_user_id = actor_user
     AND public.gphkm_is_active_org_member(o.organization_id, actor_user)
   FOR UPDATE;
  IF NOT FOUND OR checkout_state <> 'PENDING_POST' OR customer_status <> 'ORDER_RECEIVED' THEN
    RAISE EXCEPTION 'order no longer accepts items' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_lock_pending_order_item() FROM PUBLIC;
