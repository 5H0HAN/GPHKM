-- The verified dispute webhook already restores the linked grant and releases
-- its hold. Close the explicit case only when all disputes are won and there
-- are no other linked provider events awaiting Finance review.
CREATE FUNCTION public.gphkm_close_stripe_case_after_dispute_win() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE resolved_case public.stripe_reconciliation_case%ROWTYPE;
BEGIN
  IF NEW.state <> 'SETTLED' OR OLD.state IS DISTINCT FROM 'DISPUTED' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.stripe_dispute_state d
      WHERE d.payment_attempt_id = NEW.id AND d.state <> 'WON')
     OR NOT EXISTS (SELECT 1 FROM public.stripe_dispute_state d
      WHERE d.payment_attempt_id = NEW.id AND d.state = 'WON')
     OR EXISTS (SELECT 1 FROM public.provider_event e WHERE e.payment_attempt_id = NEW.id
      AND e.state = 'RECONCILIATION_REQUIRED') THEN
    RETURN NEW;
  END IF;
  UPDATE public.stripe_reconciliation_case SET state = 'RESOLVED', resolved_at = now(), updated_at = now()
   WHERE payment_attempt_id = NEW.id AND state = 'OPEN' RETURNING * INTO resolved_case;
  IF FOUND THEN
    UPDATE public.wallet_hold SET state = 'RELEASED', released_at = now()
     WHERE payment_attempt_id = NEW.id AND state = 'ACTIVE' AND reason_code = 'STRIPE_DISPUTE';
    INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, NEW.organization_id, NULL, 'STRIPE_RECONCILIATION_CASE_RESOLVED',
      'PAYMENT_ATTEMPT', NEW.id, 'VERIFIED_DISPUTE_WON', jsonb_build_object('caseId', resolved_case.id));
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_close_stripe_case_after_dispute_win() FROM PUBLIC;
CREATE TRIGGER payment_attempt_close_won_stripe_case
  AFTER UPDATE OF state ON public.payment_attempt
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_close_stripe_case_after_dispute_win();
