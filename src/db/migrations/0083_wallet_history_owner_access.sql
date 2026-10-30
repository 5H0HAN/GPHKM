-- Members see organization balance/availability, but only Owners can inspect
-- transaction-level wallet and funding records.
DROP POLICY wallet_account_tenant_read ON public.wallet_account;
CREATE POLICY wallet_account_tenant_read ON public.wallet_account FOR SELECT TO gphkm_runtime
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')
    AND public.gphkm_is_active_org_member(organization_id, nullif(current_setting('app.user_id', true), '')));

DROP POLICY wallet_account_tenant_create ON public.wallet_account;
CREATE POLICY wallet_account_tenant_create ON public.wallet_account FOR INSERT TO gphkm_runtime
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')
    AND public.gphkm_is_active_org_member(organization_id, nullif(current_setting('app.user_id', true), '')));

DROP POLICY wallet_ledger_tenant_read ON public.wallet_ledger_entry;
CREATE POLICY wallet_ledger_tenant_read ON public.wallet_ledger_entry FOR SELECT TO gphkm_runtime
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')
    AND public.gphkm_is_active_org_owner(organization_id, nullif(current_setting('app.user_id', true), '')));

DROP POLICY payment_attempt_tenant_read ON public.payment_attempt;
CREATE POLICY payment_attempt_tenant_read ON public.payment_attempt FOR SELECT TO gphkm_runtime
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')
    AND public.gphkm_is_active_org_owner(organization_id, nullif(current_setting('app.user_id', true), '')));

DROP POLICY wallet_hold_tenant_read ON public.wallet_hold;
CREATE POLICY wallet_hold_tenant_read ON public.wallet_hold FOR SELECT TO gphkm_runtime
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')
    AND public.gphkm_is_active_org_owner(organization_id, nullif(current_setting('app.user_id', true), '')));

DROP POLICY access_grant_tenant_read ON public.access_grant;
CREATE POLICY access_grant_tenant_read ON public.access_grant FOR SELECT TO gphkm_runtime
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')
    AND public.gphkm_is_active_org_member(organization_id, nullif(current_setting('app.user_id', true), '')));

-- Checkout and the customer wallet summary need the aggregate held amount to
-- calculate spendable funds. Do not grant members row-level access to holds.
CREATE FUNCTION public.gphkm_customer_wallet_held_total(target_org text) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF actor_id IS NULL OR target_org IS NULL
     OR NOT public.gphkm_is_active_org_member(target_org, actor_id) THEN
    RAISE EXCEPTION 'wallet unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce((SELECT sum(h.amount_minor) FROM public.wallet_hold h
    WHERE h.organization_id = target_org AND h.state = 'ACTIVE'), 0);
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_customer_wallet_held_total(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_customer_wallet_held_total(text) TO gphkm_runtime;
