-- Assignment is not authority after staff suspension or a role change. Customer
-- endpoints additionally apply their Owner/Member projection scope explicitly.
CREATE OR REPLACE FUNCTION public.gphkm_staff_can_read_order_item(target_item_id text, target_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_is_active_staff(target_user_id, 'SUPER_ADMIN') OR (
    public.gphkm_is_active_staff(target_user_id, 'ADMIN') AND EXISTS (
      SELECT 1 FROM public.order_item_fulfillment f
       WHERE f.order_item_id = target_item_id AND f.assigned_admin_id = target_user_id
    )
  )
$$;
CREATE OR REPLACE FUNCTION public.gphkm_staff_can_read_order(target_order_id text, target_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_is_active_staff(target_user_id, 'SUPER_ADMIN') OR (
    public.gphkm_is_active_staff(target_user_id, 'ADMIN') AND EXISTS (
      SELECT 1 FROM public.order_item_fulfillment f
       WHERE f.order_id = target_order_id AND f.assigned_admin_id = target_user_id
    )
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_staff_can_read_order_item(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gphkm_staff_can_read_order(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_staff_can_read_order_item(text,text), public.gphkm_staff_can_read_order(text,text) TO gphkm_runtime;
