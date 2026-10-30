CREATE OR REPLACE FUNCTION public.gphkm_reject_new_topup_during_provider_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.provider = 'STRIPE' AND NEW.state IN ('CREATED', 'PENDING')
     AND NOT EXISTS (SELECT 1 FROM public.payment_attempt existing
       WHERE existing.organization_id = NEW.organization_id
         AND existing.actor_user_id = NEW.actor_user_id
         AND existing.idempotency_key = NEW.idempotency_key)
     AND EXISTS (SELECT 1 FROM public.payment_attempt a
       WHERE a.organization_id = NEW.organization_id AND a.id <> NEW.id AND a.provider = 'STRIPE'
         AND (a.state IN ('DISPUTED', 'REVERSED') OR EXISTS (
           SELECT 1 FROM public.provider_event e WHERE e.payment_attempt_id = a.id
             AND (e.state = 'RECONCILIATION_REQUIRED' OR e.event_type = 'charge.refunded')))) THEN
    RAISE EXCEPTION 'wallet funding is temporarily restricted pending payment review' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.gphkm_reject_order_debit_during_provider_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.kind = 'ORDER_DEBIT' AND EXISTS (SELECT 1 FROM public.payment_attempt a
    WHERE a.organization_id = NEW.organization_id AND a.provider = 'STRIPE'
      AND (a.state IN ('DISPUTED', 'REVERSED') OR EXISTS (
        SELECT 1 FROM public.provider_event e WHERE e.payment_attempt_id = a.id
          AND (e.state = 'RECONCILIATION_REQUIRED' OR e.event_type = 'charge.refunded')))) THEN
    RAISE EXCEPTION 'wallet spending is temporarily restricted pending payment review' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.gphkm_org_wallet_spending_restricted(target_organization_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  context_org_id text := nullif(current_setting('app.organization_id', true), '');
  is_restricted boolean;
BEGIN
  IF actor_id IS NULL OR context_org_id IS DISTINCT FROM target_organization_id
     OR NOT public.gphkm_is_active_org_member(target_organization_id, actor_id) THEN
    RAISE EXCEPTION 'wallet unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.payment_attempt a
    WHERE a.organization_id = target_organization_id AND a.provider = 'STRIPE'
      AND (a.state IN ('DISPUTED', 'REVERSED') OR EXISTS (
        SELECT 1 FROM public.provider_event e WHERE e.payment_attempt_id = a.id
          AND (e.state = 'RECONCILIATION_REQUIRED' OR e.event_type = 'charge.refunded'))))
    INTO is_restricted;
  RETURN is_restricted;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_org_wallet_spending_restricted(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_org_wallet_spending_restricted(text) TO gphkm_runtime;
