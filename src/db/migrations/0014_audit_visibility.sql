-- Narrow audit reads to the approved staff role scopes. Customer code receives no
-- direct audit-table reads; customer-facing history comes from explicit projections.
DROP POLICY audit_event_tenant_read ON audit_event;

CREATE POLICY audit_event_staff_scoped_read ON audit_event FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
  OR (
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'ADMIN')
    AND (
      (actor_user_id = nullif(current_setting('app.user_id', true), '')
        AND action NOT LIKE 'WALLET_%' AND action NOT LIKE 'STRIPE_%'
        AND action NOT LIKE 'SUPPLIER_COST_%' AND action NOT LIKE 'SUPPLIER_PAYMENT_%'
        AND action NOT LIKE 'REFUND_%')
      OR (target_type = 'CUSTOMER_ORDER_ITEM' AND EXISTS (
        SELECT 1 FROM public.order_item_fulfillment f
         WHERE f.order_item_id = audit_event.target_id
           AND f.assigned_admin_id = nullif(current_setting('app.user_id', true), '')
      ))
    )
  )
  OR (
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE')
    AND (
      action LIKE 'WALLET_%' OR action LIKE 'STRIPE_%'
      OR action LIKE 'SUPPLIER_COST_%' OR action LIKE 'SUPPLIER_PAYMENT_%'
      OR action LIKE 'REFUND_%' OR action LIKE 'SUPPORT_FINANCE_%'
      OR target_type IN ('PAYMENT_ATTEMPT', 'WALLET_HOLD', 'WALLET_LEDGER_ENTRY', 'ORDER_ITEM_FINANCIAL')
    )
  )
);

-- Every application-created event must identify the current actor (system
-- definer functions write their events under their own restricted owner).
DROP POLICY audit_event_tenant_insert ON audit_event;
CREATE POLICY audit_event_actor_insert ON audit_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id', true), '')
  AND (
    public.gphkm_is_active_staff(actor_user_id, 'ADMIN')
    OR public.gphkm_is_active_staff(actor_user_id, 'FINANCE')
    OR public.gphkm_is_active_staff(actor_user_id, 'SUPER_ADMIN')
    OR (organization_id = nullif(current_setting('app.organization_id', true), '')
      AND public.gphkm_is_active_org_member(organization_id, actor_user_id))
  )
);
