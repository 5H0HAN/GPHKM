-- Staff retain access to supplier notices as audit and reconciliation evidence
-- after an order Support conversation is resolved, closed, or merged.
DROP POLICY supplier_item_notice_staff_read ON public.supplier_item_notice;--> statement-breakpoint
CREATE POLICY supplier_item_notice_staff_read ON public.supplier_item_notice FOR SELECT TO gphkm_runtime USING (
  public.gphkm_supplier_packet_access(packet_id, nullif(current_setting('app.user_id',true),''))
  AND EXISTS (SELECT 1 FROM public.support_case c JOIN public.customer_order_item i ON i.order_id = c.order_id
    JOIN public.order_item_fulfillment f ON f.order_item_id = i.id
    WHERE c.id = case_id
      AND i.id = supplier_item_notice.order_item_id
      AND (f.assigned_admin_id = nullif(current_setting('app.user_id',true),'') OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id',true),''),'SUPER_ADMIN')))
);
