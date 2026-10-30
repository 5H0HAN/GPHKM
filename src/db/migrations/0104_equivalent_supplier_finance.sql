CREATE INDEX supplier_order_cost_item_supplier_component_created_idx
  ON public.supplier_order_item_cost_event(order_item_id, supplier_id, component, created_at DESC, id DESC);--> statement-breakpoint

UPDATE public.order_item_fulfillment_supplier route
   SET supplier_id = financial.fulfillment_supplier_id
  FROM public.order_item_financial financial
 WHERE route.order_item_id = financial.order_item_id
   AND route.supplier_id IS NULL AND financial.fulfillment_supplier_id IS NOT NULL;--> statement-breakpoint

CREATE FUNCTION public.gphkm_finance_item_suppliers(target_order_item_id text)
RETURNS TABLE(supplier_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT eligible.supplier_id
    FROM (
      SELECT financial.supplier_id
        FROM public.order_item_financial financial
       WHERE financial.order_item_id = target_order_item_id
      UNION
      SELECT financial.fulfillment_supplier_id
        FROM public.order_item_financial financial
       WHERE financial.order_item_id = target_order_item_id
      UNION
      SELECT current_route.supplier_id
        FROM public.order_item_fulfillment_supplier current_route
       WHERE current_route.order_item_id = target_order_item_id
      UNION
      SELECT accepted_route.supplier_id
        FROM public.order_item_equivalent_offer offer
        JOIN public.order_item_equivalent_offer_route accepted_route ON accepted_route.offer_id = offer.id
        JOIN public.order_item_equivalent_offer_event accepted
          ON accepted.offer_id = offer.id AND accepted.event_type = 'ACCEPTED'
         AND accepted.content_hash = accepted_route.content_hash
        JOIN public.customer_order_item item ON item.id = offer.order_item_id
        JOIN public.customer_order customer_order ON customer_order.id = item.order_id
         AND customer_order.actor_user_id = accepted.actor_user_id
       WHERE offer.order_item_id = target_order_item_id
    ) eligible
   WHERE eligible.supplier_id IS NOT NULL
     AND (public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE')
       OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN'))
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_finance_item_suppliers(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_finance_item_suppliers(text) TO gphkm_runtime;--> statement-breakpoint

CREATE FUNCTION public.gphkm_finance_item_supplier_allowed(target_order_item_id text, target_supplier_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT target_supplier_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.gphkm_finance_item_suppliers(target_order_item_id) eligible
     WHERE eligible.supplier_id = target_supplier_id
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_finance_item_supplier_allowed(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_finance_item_supplier_allowed(text, text) TO gphkm_runtime;--> statement-breakpoint

CREATE POLICY order_item_fulfillment_supplier_finance_read ON public.order_item_fulfillment_supplier FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);--> statement-breakpoint

DROP POLICY supplier_order_cost_event_finance_insert ON public.supplier_order_item_cost_event;--> statement-breakpoint
CREATE POLICY supplier_order_cost_event_finance_insert ON public.supplier_order_item_cost_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id', true), '') AND (
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
  ) AND (
    (component = 'WRITING' AND supplier_id IS NULL) OR
    (component = 'PLACEMENT' AND (
      (supplier_id IS NOT NULL AND public.gphkm_finance_item_supplier_allowed(order_item_id, supplier_id)) OR
      (supplier_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.gphkm_finance_item_suppliers(order_item_id)))
    ))
  )
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_supplier_transfer_allocation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE transfer_supplier_id text;
BEGIN
  SELECT event.supplier_id INTO transfer_supplier_id
    FROM public.supplier_transfer_event event WHERE event.id = NEW.transfer_event_id;
  IF transfer_supplier_id IS NULL
     OR NEW.actor_user_id <> nullif(current_setting('app.user_id', true), '')
     OR NOT public.gphkm_finance_item_supplier_allowed(NEW.order_item_id, transfer_supplier_id)
     OR NOT EXISTS (
       SELECT 1 FROM public.audit_event a
        WHERE a.actor_user_id = NEW.actor_user_id
          AND a.action = 'SUPPLIER_TRANSFER_ALLOCATED'
          AND a.target_type = 'supplier_transfer_allocation'
          AND a.target_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'supplier transfer allocation must match an authorized order-item supplier and authenticated audit actor';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_supplier_transfer_allocation_guard() FROM PUBLIC;--> statement-breakpoint

DROP POLICY supplier_transfer_allocation_finance_insert ON public.supplier_transfer_allocation;--> statement-breakpoint
CREATE POLICY supplier_transfer_allocation_finance_insert ON public.supplier_transfer_allocation FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id', true), '') AND
  (public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
   public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')) AND
  EXISTS (
    SELECT 1 FROM public.supplier_transfer_event event
     WHERE event.id = supplier_transfer_allocation.transfer_event_id
       AND public.gphkm_finance_item_supplier_allowed(supplier_transfer_allocation.order_item_id, event.supplier_id)
  )
);
