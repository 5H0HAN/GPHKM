-- Custom SQL migration file, put your code below! --
CREATE OR REPLACE FUNCTION public.gphkm_closure_blockers(target_org text) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 SELECT array_remove(ARRAY[
   CASE WHEN coalesce((SELECT balance_minor FROM public.wallet_account WHERE organization_id=target_org),0) <> 0 THEN 'WALLET_BALANCE' END,
   CASE WHEN EXISTS (SELECT 1 FROM public.customer_order o WHERE o.organization_id=target_org AND (
     o.checkout_state='PENDING_POST' OR EXISTS (
       SELECT 1 FROM public.customer_order_item i LEFT JOIN public.order_item_fulfillment f ON f.order_item_id=i.id
       WHERE i.order_id=o.id AND (f.order_item_id IS NULL OR f.state NOT IN ('COMPLETED','CANCELED_REFUNDED'))
     ))) THEN 'ACTIVE_ORDERS' END,
   CASE WHEN EXISTS (SELECT 1 FROM public.stripe_reconciliation_case WHERE organization_id=target_org AND state='OPEN') THEN 'OPEN_STRIPE_CASES' END,
   CASE WHEN EXISTS (SELECT 1 FROM public.support_case WHERE organization_id=target_org AND state NOT IN ('RESOLVED','CLOSED')) THEN 'OPEN_SUPPORT_CASES' END,
   CASE WHEN EXISTS (SELECT 1 FROM public.payment_attempt WHERE organization_id=target_org AND state IN ('CREATED','PENDING','DISPUTED')) THEN 'UNRESOLVED_PAYMENTS' END
 ],NULL)
$$;
