-- A disputed or reversed top-up remains an organization-level spend restriction
-- until a Finance resolution command has reconciled current provider facts.
CREATE FUNCTION public.gphkm_reject_new_topup_during_provider_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.provider = 'STRIPE' AND NEW.state IN ('CREATED', 'PENDING')
     AND NOT EXISTS (SELECT 1 FROM public.payment_attempt existing
       WHERE existing.organization_id = NEW.organization_id
         AND existing.actor_user_id = NEW.actor_user_id
         AND existing.idempotency_key = NEW.idempotency_key)
     AND EXISTS (SELECT 1 FROM public.payment_attempt a
       WHERE a.organization_id = NEW.organization_id AND a.id <> NEW.id
         AND a.provider = 'STRIPE' AND a.state IN ('DISPUTED', 'REVERSED')) THEN
    RAISE EXCEPTION 'wallet funding is temporarily restricted pending payment review' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_new_topup_during_provider_review() FROM PUBLIC;
CREATE TRIGGER payment_attempt_provider_review_guard
  BEFORE INSERT ON public.payment_attempt
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_new_topup_during_provider_review();

CREATE FUNCTION public.gphkm_reject_order_debit_during_provider_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.kind = 'ORDER_DEBIT' AND EXISTS (SELECT 1 FROM public.payment_attempt a
    WHERE a.organization_id = NEW.organization_id AND a.provider = 'STRIPE'
      AND a.state IN ('DISPUTED', 'REVERSED')) THEN
    RAISE EXCEPTION 'wallet spending is temporarily restricted pending payment review' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_order_debit_during_provider_review() FROM PUBLIC;
CREATE TRIGGER wallet_ledger_provider_review_guard
  BEFORE INSERT ON public.wallet_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_order_debit_during_provider_review();
