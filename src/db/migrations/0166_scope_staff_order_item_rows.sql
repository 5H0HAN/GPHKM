-- Prevent the order-level staff SELECT policy from expanding item-level access.
DROP POLICY customer_order_item_read ON public.customer_order_item;--> statement-breakpoint
CREATE POLICY customer_order_item_read ON public.customer_order_item FOR SELECT TO gphkm_runtime USING (
  NOT public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''))
  AND public.gphkm_customer_can_read_order_item(id,
    nullif(current_setting('app.user_id', true), ''), nullif(current_setting('app.organization_id', true), ''))
);--> statement-breakpoint

-- Return only a count to Support callers that already have access to the case.
CREATE OR REPLACE FUNCTION public.gphkm_support_case_placement_count(target_case_id text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN case_row.order_id IS NULL THEN 0 ELSE (
    SELECT count(*)::integer FROM public.customer_order_item item WHERE item.order_id = case_row.order_id
  ) END
  FROM public.support_case case_row
  WHERE case_row.id = target_case_id AND (
    public.gphkm_support_admin_access(case_row.id, nullif(current_setting('app.user_id', true), ''))
    OR public.gphkm_support_finance_access(case_row.id, nullif(current_setting('app.user_id', true), ''))
    OR public.gphkm_support_customer_access(case_row.id,
      nullif(current_setting('app.user_id', true), ''), nullif(current_setting('app.organization_id', true), ''))
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_support_case_placement_count(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_support_case_placement_count(text) TO gphkm_runtime;--> statement-breakpoint
