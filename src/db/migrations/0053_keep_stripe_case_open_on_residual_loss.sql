CREATE FUNCTION public.gphkm_keep_uncovered_stripe_case_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE latest_uncovered numeric;
BEGIN
  IF NEW.state = 'RESOLVED' THEN
    SELECT d.uncovered_minor INTO latest_uncovered FROM public.stripe_reconciliation_decision d
     WHERE d.case_id = NEW.id ORDER BY d.created_at DESC, d.id DESC LIMIT 1;
    IF coalesce(latest_uncovered,0) > 0 THEN
      NEW.state := 'OPEN';
      NEW.resolved_at := NULL;
      NEW.updated_at := clock_timestamp();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_keep_uncovered_stripe_case_open() FROM PUBLIC;
CREATE TRIGGER stripe_reconciliation_case_require_full_recovery
  BEFORE UPDATE OF state ON public.stripe_reconciliation_case
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_keep_uncovered_stripe_case_open();

-- The earlier dispute-win trigger must not release a hold when this guard
-- rewrites RESOLVED back to OPEN because uncovered loss remains.
CREATE OR REPLACE FUNCTION public.gphkm_close_stripe_case_after_dispute_win() RETURNS trigger
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
  IF FOUND AND resolved_case.state = 'RESOLVED' THEN
    UPDATE public.wallet_hold SET state = 'RELEASED', released_at = now()
     WHERE payment_attempt_id = NEW.id AND state = 'ACTIVE' AND reason_code = 'STRIPE_DISPUTE';
    INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, NEW.organization_id, NULL, 'STRIPE_RECONCILIATION_CASE_RESOLVED',
      'PAYMENT_ATTEMPT', NEW.id, 'VERIFIED_DISPUTE_WON', jsonb_build_object('caseId', resolved_case.id));
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.gphkm_rehold_available_wallet_after_partial_stripe_recovery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  latest_uncovered numeric;
  wallet_minor numeric;
  other_holds numeric;
  remaining_available numeric;
  hold_id text;
  ledger_id text;
  hold_reason text;
BEGIN
  IF NEW.state <> 'OPEN' OR OLD.state <> 'OPEN' THEN RETURN NEW; END IF;
  SELECT d.uncovered_minor INTO latest_uncovered FROM public.stripe_reconciliation_decision d
   WHERE d.case_id = NEW.id ORDER BY d.created_at DESC, d.id DESC LIMIT 1;
  IF coalesce(latest_uncovered,0) <= 0 THEN RETURN NEW; END IF;
  SELECT balance_minor INTO wallet_minor FROM public.wallet_account WHERE organization_id = NEW.organization_id FOR UPDATE;
  IF wallet_minor IS NULL THEN RETURN NEW; END IF;
  SELECT coalesce(sum(amount_minor),0) INTO other_holds FROM public.wallet_hold
   WHERE organization_id = NEW.organization_id AND state = 'ACTIVE'
     AND payment_attempt_id IS DISTINCT FROM NEW.payment_attempt_id;
  remaining_available := greatest(wallet_minor - other_holds,0);
  SELECT id INTO ledger_id FROM public.wallet_ledger_entry
   WHERE organization_id = NEW.organization_id AND operation = 'STRIPE_TOP_UP'
     AND idempotency_key = NEW.payment_attempt_id LIMIT 1;
  SELECT id INTO hold_id FROM public.wallet_hold WHERE payment_attempt_id = NEW.payment_attempt_id
   ORDER BY created_at DESC, id DESC LIMIT 1;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.provider_event WHERE payment_attempt_id = NEW.payment_attempt_id
      AND event_type = 'charge.refunded') THEN 'STRIPE_REFUND' ELSE 'STRIPE_DISPUTE' END INTO hold_reason;
  IF remaining_available > 0 THEN
    IF hold_id IS NOT NULL THEN
      UPDATE public.wallet_hold SET amount_minor = remaining_available, state = 'ACTIVE', released_at = NULL
       WHERE id = hold_id;
    ELSE
      INSERT INTO public.wallet_hold(id, organization_id, ledger_entry_id, payment_attempt_id,
        amount_minor, state, reason_code)
      VALUES (gen_random_uuid()::text, NEW.organization_id, ledger_id, NEW.payment_attempt_id,
        remaining_available, 'ACTIVE', hold_reason);
    END IF;
  ELSE
    UPDATE public.wallet_hold SET state = 'RELEASED', released_at = now()
     WHERE payment_attempt_id = NEW.payment_attempt_id AND state = 'ACTIVE'
       AND reason_code IN ('STRIPE_DISPUTE','STRIPE_REFUND');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_rehold_available_wallet_after_partial_stripe_recovery() FROM PUBLIC;
CREATE TRIGGER stripe_reconciliation_case_rehold_after_partial
  AFTER UPDATE OF state ON public.stripe_reconciliation_case
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_rehold_available_wallet_after_partial_stripe_recovery();

CREATE FUNCTION public.gphkm_label_partial_stripe_recovery_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.action = 'STRIPE_RECONCILIATION_RESOLVED'
     AND coalesce((NEW.metadata->>'uncoveredMinor')::numeric,0) > 0 THEN
    NEW.action := 'STRIPE_RECONCILIATION_PARTIAL';
    NEW.reason_code := 'RECOVERY_INCOMPLETE_CASE_REMAINS_OPEN';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_label_partial_stripe_recovery_audit() FROM PUBLIC;
CREATE TRIGGER audit_event_label_partial_stripe_recovery
  BEFORE INSERT ON public.audit_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_label_partial_stripe_recovery_audit();

-- A committed Finance decision can be safely retried after a lost response.
-- The snapshot is the idempotency key; changed actor/evidence/reason conflicts.
ALTER FUNCTION public.gphkm_resolve_stripe_reconciliation_case(text,text,text,text)
  RENAME TO gphkm_resolve_stripe_reconciliation_case_apply;
REVOKE ALL ON FUNCTION public.gphkm_resolve_stripe_reconciliation_case_apply(text,text,text,text) FROM PUBLIC, gphkm_runtime;
CREATE FUNCTION public.gphkm_resolve_stripe_reconciliation_case(
  target_attempt_id text, target_snapshot_id text, target_evidence_reference text, target_reason text
) RETURNS TABLE(provider_loss_minor numeric, wallet_recovery_minor numeric, uncovered_minor numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  attempt_exists boolean;
  prior public.stripe_reconciliation_decision%ROWTYPE;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'FINANCE') THEN
    RAISE EXCEPTION 'Stripe reconciliation unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT true INTO attempt_exists FROM public.payment_attempt
   WHERE id = target_attempt_id AND provider = 'STRIPE' FOR UPDATE;
  IF attempt_exists IS DISTINCT FROM true THEN RAISE EXCEPTION 'Stripe funding attempt unavailable' USING ERRCODE = '23514'; END IF;
  SELECT d.* INTO prior FROM public.stripe_reconciliation_decision d
    JOIN public.stripe_reconciliation_case c ON c.id = d.case_id
   WHERE c.payment_attempt_id = target_attempt_id AND d.snapshot_id = target_snapshot_id;
  IF FOUND THEN
    IF prior.actor_user_id <> actor_id
       OR prior.evidence_reference <> btrim(target_evidence_reference)
       OR prior.reason <> btrim(target_reason) THEN
      RAISE EXCEPTION 'This Stripe snapshot already has a different Finance decision' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT prior.provider_loss_minor, prior.wallet_recovery_minor, prior.uncovered_minor;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM public.gphkm_resolve_stripe_reconciliation_case_apply(
    target_attempt_id, target_snapshot_id, target_evidence_reference, target_reason);
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_resolve_stripe_reconciliation_case(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_resolve_stripe_reconciliation_case(text,text,text,text) TO gphkm_runtime;
