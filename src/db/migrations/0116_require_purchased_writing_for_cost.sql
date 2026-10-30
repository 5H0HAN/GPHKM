CREATE FUNCTION public.gphkm_finance_writing_cost_allowed(target_order_item_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT (public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE')
       OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN'))
     AND EXISTS (
       SELECT 1 FROM public.customer_order_item item
        WHERE item.id = target_order_item_id AND item.writing_selected
     )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_finance_writing_cost_allowed(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_finance_writing_cost_allowed(text) TO gphkm_runtime;--> statement-breakpoint

DROP POLICY supplier_order_cost_event_finance_insert ON public.supplier_order_item_cost_event;--> statement-breakpoint
CREATE POLICY supplier_order_cost_event_finance_insert ON public.supplier_order_item_cost_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id', true), '') AND (
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
  ) AND (
    (component = 'WRITING' AND supplier_id IS NULL AND public.gphkm_finance_writing_cost_allowed(order_item_id)) OR
    (component = 'PLACEMENT' AND (
      (supplier_id IS NOT NULL AND public.gphkm_finance_item_supplier_allowed(order_item_id, supplier_id)) OR
      (supplier_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.gphkm_finance_item_suppliers(order_item_id)))
    ))
  )
);--> statement-breakpoint
