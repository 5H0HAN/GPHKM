-- Custom SQL migration file, put your code below! --
CREATE TABLE public.stripe_reconciliation_case (
  id text PRIMARY KEY,
  payment_attempt_id text NOT NULL UNIQUE REFERENCES public.payment_attempt(id),
  organization_id text NOT NULL REFERENCES public.organization(id),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','RESOLVED')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'OPEN' AND resolved_at IS NULL) OR (state = 'RESOLVED' AND resolved_at IS NOT NULL))
);
ALTER TABLE public.stripe_reconciliation_case ENABLE ROW LEVEL SECURITY;
CREATE INDEX stripe_reconciliation_case_org_state_idx ON public.stripe_reconciliation_case(organization_id, state);
REVOKE ALL ON public.stripe_reconciliation_case FROM PUBLIC, gphkm_runtime;

CREATE TABLE public.stripe_reconciliation_decision (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES public.stripe_reconciliation_case(id),
  snapshot_id text NOT NULL UNIQUE REFERENCES public.stripe_finance_snapshot(id),
  actor_user_id text NOT NULL REFERENCES public.auth_user(id),
  provider_loss_minor numeric(20,0) NOT NULL CHECK (provider_loss_minor >= 0),
  wallet_recovery_minor numeric(20,0) NOT NULL CHECK (wallet_recovery_minor >= 0),
  uncovered_minor numeric(20,0) NOT NULL CHECK (uncovered_minor >= 0),
  evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 3 AND 200),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stripe_reconciliation_decision ENABLE ROW LEVEL SECURITY;
CREATE INDEX stripe_reconciliation_decision_case_created_idx ON public.stripe_reconciliation_decision(case_id, created_at);
REVOKE ALL ON public.stripe_reconciliation_decision FROM PUBLIC, gphkm_runtime;
CREATE TRIGGER stripe_reconciliation_decision_immutable
  BEFORE UPDATE OR DELETE ON public.stripe_reconciliation_decision
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_finance_reconciliation_mutation();

-- The source of truth for review restrictions is the case, so a resolved
-- reversal does not leave a permanent block merely because its attempt state
-- remains REVERSED for historical accuracy.
INSERT INTO public.stripe_reconciliation_case(id, payment_attempt_id, organization_id)
SELECT gen_random_uuid()::text, a.id, a.organization_id
FROM public.payment_attempt a
WHERE a.provider = 'STRIPE' AND (
  a.state IN ('DISPUTED','REVERSED') OR EXISTS (
    SELECT 1 FROM public.provider_event e WHERE e.payment_attempt_id = a.id AND e.state = 'RECONCILIATION_REQUIRED'
  )
)
ON CONFLICT (payment_attempt_id) DO NOTHING;

CREATE FUNCTION public.gphkm_open_stripe_reconciliation_case() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE attempt_org text;
BEGIN
  IF NEW.state <> 'RECONCILIATION_REQUIRED' OR NEW.payment_attempt_id IS NULL THEN RETURN NEW; END IF;
  SELECT organization_id INTO attempt_org FROM public.payment_attempt
    WHERE id = NEW.payment_attempt_id AND provider = 'STRIPE';
  IF attempt_org IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.stripe_reconciliation_case(id, payment_attempt_id, organization_id)
  VALUES (gen_random_uuid()::text, NEW.payment_attempt_id, attempt_org)
  ON CONFLICT (payment_attempt_id) DO UPDATE
    SET state = 'OPEN', opened_at = now(), resolved_at = NULL, updated_at = now()
    WHERE stripe_reconciliation_case.state = 'RESOLVED';
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_open_stripe_reconciliation_case() FROM PUBLIC;
CREATE TRIGGER provider_event_open_reconciliation_case
  AFTER INSERT OR UPDATE OF state, payment_attempt_id ON public.provider_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_open_stripe_reconciliation_case();

CREATE FUNCTION public.gphkm_open_stripe_case_for_risky_attempt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.state NOT IN ('DISPUTED','REVERSED') OR OLD.state IS NOT DISTINCT FROM NEW.state THEN RETURN NEW; END IF;
  INSERT INTO public.stripe_reconciliation_case(id, payment_attempt_id, organization_id)
  VALUES (gen_random_uuid()::text, NEW.id, NEW.organization_id)
  ON CONFLICT (payment_attempt_id) DO UPDATE
    SET state = 'OPEN', opened_at = now(), resolved_at = NULL, updated_at = now()
    WHERE stripe_reconciliation_case.state = 'RESOLVED';
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_open_stripe_case_for_risky_attempt() FROM PUBLIC;
CREATE TRIGGER payment_attempt_open_reconciliation_case
  AFTER UPDATE OF state ON public.payment_attempt
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_open_stripe_case_for_risky_attempt();

CREATE OR REPLACE FUNCTION public.gphkm_reject_new_topup_during_provider_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.provider = 'STRIPE' AND NEW.state IN ('CREATED', 'PENDING')
     AND NOT EXISTS (SELECT 1 FROM public.payment_attempt existing
       WHERE existing.organization_id = NEW.organization_id AND existing.actor_user_id = NEW.actor_user_id
         AND existing.idempotency_key = NEW.idempotency_key)
     AND EXISTS (SELECT 1 FROM public.stripe_reconciliation_case c
       WHERE c.organization_id = NEW.organization_id AND c.state = 'OPEN') THEN
    RAISE EXCEPTION 'wallet funding is temporarily restricted pending payment review' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.gphkm_reject_order_debit_during_provider_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.kind = 'ORDER_DEBIT' AND EXISTS (SELECT 1 FROM public.stripe_reconciliation_case c
    WHERE c.organization_id = NEW.organization_id AND c.state = 'OPEN') THEN
    RAISE EXCEPTION 'wallet spending is temporarily restricted pending payment review' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.gphkm_org_wallet_spending_restricted(target_organization_id text) RETURNS boolean
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
  SELECT EXISTS (SELECT 1 FROM public.stripe_reconciliation_case c
    WHERE c.organization_id = target_organization_id AND c.state = 'OPEN') INTO is_restricted;
  RETURN is_restricted;
END;
$$;

CREATE FUNCTION public.gphkm_list_open_stripe_reconciliation_snapshots()
RETURNS TABLE(payment_attempt_id text, organization_id text, attempt_state text, case_id text,
  snapshot_id text, snapshot_created_at timestamptz, snapshot_complete boolean, facts jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') THEN
    RAISE EXCEPTION 'Stripe provider review unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT a.id, a.organization_id, a.state, c.id, s.id, s.created_at, s.complete, s.facts
  FROM public.stripe_reconciliation_case c
  JOIN public.payment_attempt a ON a.id = c.payment_attempt_id
  JOIN LATERAL (SELECT x.id, x.created_at, x.complete, x.facts FROM public.stripe_finance_snapshot x
    WHERE x.payment_attempt_id = a.id ORDER BY x.created_at DESC, x.id DESC LIMIT 1) s ON true
  WHERE c.state = 'OPEN' ORDER BY c.opened_at LIMIT 100;
END;
$$;

CREATE FUNCTION public.gphkm_resolve_stripe_reconciliation_case(
  target_attempt_id text, target_snapshot_id text, target_evidence_reference text, target_reason text
) RETURNS TABLE(provider_loss_minor numeric, wallet_recovery_minor numeric, uncovered_minor numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  attempt_row public.payment_attempt%ROWTYPE;
  case_row public.stripe_reconciliation_case%ROWTYPE;
  snapshot_row public.stripe_finance_snapshot%ROWTYPE;
  wallet_minor numeric;
  other_holds numeric;
  prior_recovery numeric;
  available_minor numeric;
  new_recovery numeric;
  delta_minor numeric;
  loss_minor numeric;
  tx_count integer;
  unresolved_unknown_count integer;
  latest_event_at timestamptz;
  resolution_id text := gen_random_uuid()::text;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'FINANCE')
     OR target_attempt_id IS NULL OR target_attempt_id !~ '^[0-9a-f-]{36}$'
     OR target_snapshot_id IS NULL OR target_snapshot_id !~ '^[0-9a-f-]{36}$'
     OR target_evidence_reference IS NULL OR length(btrim(target_evidence_reference)) NOT BETWEEN 3 AND 200
     OR target_evidence_reference ~ '[[:cntrl:]]'
     OR target_reason IS NULL OR length(btrim(target_reason)) NOT BETWEEN 10 AND 1000
     OR target_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Stripe reconciliation decision invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO attempt_row FROM public.payment_attempt WHERE id = target_attempt_id AND provider = 'STRIPE' FOR UPDATE;
  SELECT * INTO case_row FROM public.stripe_reconciliation_case
    WHERE payment_attempt_id = target_attempt_id AND state = 'OPEN' FOR UPDATE;
  SELECT * INTO snapshot_row FROM public.stripe_finance_snapshot
    WHERE id = target_snapshot_id AND payment_attempt_id = target_attempt_id FOR SHARE;
  IF NOT FOUND OR case_row.id IS NULL OR attempt_row.id IS NULL OR snapshot_row.id IS NULL
     OR snapshot_row.complete IS NOT TRUE OR snapshot_row.facts->>'detailComplete' IS DISTINCT FROM 'true'
     OR snapshot_row.facts->>'paginationComplete' IS DISTINCT FROM 'true'
     OR snapshot_row.facts->>'snapshotTruncated' IS DISTINCT FROM 'false'
     OR snapshot_row.facts->>'providerPaymentId' IS DISTINCT FROM attempt_row.provider_payment_id
     OR snapshot_row.facts->>'amountMinor' IS DISTINCT FROM attempt_row.amount_minor::text
     OR lower(snapshot_row.facts->>'currency') IS DISTINCT FROM lower(attempt_row.currency)
     OR snapshot_row.facts->>'paymentStatus' IS DISTINCT FROM 'succeeded'
     OR snapshot_row.facts->>'amountReceivedMinor' IS DISTINCT FROM attempt_row.amount_minor::text
     OR snapshot_row.facts->>'providerMode' NOT IN ('test','live')
     OR (snapshot_row.facts->>'refreshedAt')::timestamptz < now() - interval '15 minutes'
     OR (snapshot_row.facts->>'refreshedAt')::timestamptz > now() + interval '1 minute'
     OR EXISTS (SELECT 1 FROM public.stripe_finance_snapshot newer WHERE newer.payment_attempt_id = target_attempt_id
       AND (newer.created_at, newer.id) > (snapshot_row.created_at, snapshot_row.id)) THEN
    RAISE EXCEPTION 'A complete current Stripe snapshot is required' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stripe_reconciliation_decision d WHERE d.snapshot_id = target_snapshot_id) THEN
    RAISE EXCEPTION 'This provider snapshot has already been reconciled' USING ERRCODE = '23505';
  END IF;
  SELECT max(received_at) INTO latest_event_at FROM public.provider_event
    WHERE payment_attempt_id = target_attempt_id AND state = 'RECONCILIATION_REQUIRED';
  IF latest_event_at IS NOT NULL AND snapshot_row.created_at < latest_event_at THEN
    RAISE EXCEPTION 'Refresh Stripe after the latest unresolved provider event' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO unresolved_unknown_count FROM public.provider_event
    WHERE payment_attempt_id = target_attempt_id AND state = 'RECONCILIATION_REQUIRED'
      AND event_type NOT IN ('charge.refunded','charge.dispute.created','charge.dispute.closed');
  IF unresolved_unknown_count > 0 THEN RAISE EXCEPTION 'An unresolved provider event requires separate review' USING ERRCODE = '23514'; END IF;
  IF (snapshot_row.facts->>'pendingRefundCount')::integer <> 0
     OR (snapshot_row.facts->>'openDisputeCount')::integer <> 0 THEN
    RAISE EXCEPTION 'Pending refunds or open disputes must settle before resolution' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot_row.facts->'refunds') r
    WHERE r->>'status' NOT IN ('succeeded','failed','canceled')
       OR r->>'currency' IS DISTINCT FROM lower(attempt_row.currency)
       OR (r->>'status' = 'succeeded' AND (r->'balanceTransaction' IS NULL OR r->'balanceTransaction' = 'null'::jsonb
         OR r->'balanceTransaction'->>'status' IS DISTINCT FROM 'available'
         OR r->'balanceTransaction'->>'currency' IS DISTINCT FROM lower(attempt_row.currency))))
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot_row.facts->'disputes') d
       WHERE d->>'status' NOT IN ('won','lost','warning_closed')
          OR d->>'currency' IS DISTINCT FROM lower(attempt_row.currency)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(d->'balanceTransactions') bt WHERE bt->>'status' IS DISTINCT FROM 'available')) THEN
    RAISE EXCEPTION 'Provider refund or dispute records are incomplete or unsettled' USING ERRCODE = '23514';
  END IF;
  WITH provider_transactions AS (
    SELECT r->'balanceTransaction'->>'id' AS transaction_id,
      (r->'balanceTransaction'->>'amountMinor')::numeric AS amount_minor
    FROM jsonb_array_elements(snapshot_row.facts->'refunds') r WHERE r->>'status' = 'succeeded'
    UNION ALL
    SELECT bt->>'id', (bt->>'amountMinor')::numeric
    FROM jsonb_array_elements(snapshot_row.facts->'disputes') d
    CROSS JOIN LATERAL jsonb_array_elements(d->'balanceTransactions') bt
  )
  SELECT coalesce(sum(amount_minor),0), count(*), count(DISTINCT transaction_id)
    INTO loss_minor, tx_count, unresolved_unknown_count FROM provider_transactions;
  IF tx_count <> unresolved_unknown_count THEN
    RAISE EXCEPTION 'Duplicate provider balance transactions require review' USING ERRCODE = '23514';
  END IF;
  loss_minor := least(greatest(-loss_minor,0), attempt_row.amount_minor);

  SELECT coalesce(sum(-delta_minor),0) INTO prior_recovery FROM public.wallet_ledger_entry
    WHERE organization_id = attempt_row.organization_id AND operation = 'STRIPE_RECONCILIATION'
      AND related_type = 'PAYMENT_ATTEMPT' AND related_id = target_attempt_id;
  prior_recovery := greatest(prior_recovery,0);
  SELECT balance_minor INTO wallet_minor FROM public.wallet_account
    WHERE organization_id = attempt_row.organization_id FOR UPDATE;
  SELECT coalesce(sum(amount_minor),0) INTO other_holds FROM public.wallet_hold
    WHERE organization_id = attempt_row.organization_id AND state = 'ACTIVE'
      AND payment_attempt_id IS DISTINCT FROM target_attempt_id;
  available_minor := greatest(wallet_minor - other_holds,0);
  IF loss_minor < prior_recovery THEN
    new_recovery := loss_minor;
  ELSE
    new_recovery := prior_recovery + least(loss_minor - prior_recovery, available_minor);
  END IF;
  delta_minor := new_recovery - prior_recovery;
  IF delta_minor <> 0 THEN
    INSERT INTO public.wallet_ledger_entry(id, organization_id, actor_user_id, kind, delta_minor,
      currency, operation, idempotency_key, related_type, related_id, reason_code)
    VALUES (resolution_id, attempt_row.organization_id, actor_id, 'REVERSAL', -delta_minor,
      attempt_row.currency, 'STRIPE_RECONCILIATION', target_snapshot_id, 'PAYMENT_ATTEMPT', target_attempt_id,
      CASE WHEN delta_minor > 0 THEN 'PROVIDER_PRINCIPAL_RECOVERY' ELSE 'PROVIDER_FUNDS_REINSTATED' END);
  END IF;
  INSERT INTO public.stripe_reconciliation_decision(id, case_id, snapshot_id, actor_user_id,
    provider_loss_minor, wallet_recovery_minor, uncovered_minor, evidence_reference, reason)
  VALUES (resolution_id, case_row.id, target_snapshot_id, actor_id, loss_minor, new_recovery,
    greatest(loss_minor - new_recovery,0), btrim(target_evidence_reference), btrim(target_reason));

  UPDATE public.provider_event SET state = 'PROCESSED', processed_at = now()
    WHERE payment_attempt_id = target_attempt_id AND state = 'RECONCILIATION_REQUIRED'
      AND event_type IN ('charge.refunded','charge.dispute.created','charge.dispute.closed');
  UPDATE public.wallet_hold SET state = 'RELEASED', released_at = now()
    WHERE payment_attempt_id = target_attempt_id AND state = 'ACTIVE'
      AND reason_code IN ('STRIPE_DISPUTE','STRIPE_REFUND');
  UPDATE public.stripe_reconciliation_case SET state = 'RESOLVED', resolved_at = now(), updated_at = now()
    WHERE id = case_row.id;
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
  VALUES (gen_random_uuid()::text, attempt_row.organization_id, actor_id, 'STRIPE_RECONCILIATION_RESOLVED',
    'PAYMENT_ATTEMPT', target_attempt_id, 'CURRENT_PROVIDER_SNAPSHOT_RECONCILED',
    jsonb_build_object('snapshotId', target_snapshot_id, 'providerLossMinor', loss_minor::text,
      'walletRecoveryMinor', new_recovery::text, 'uncoveredMinor', greatest(loss_minor-new_recovery,0)::text,
      'evidenceReference', btrim(target_evidence_reference)));
  RETURN QUERY SELECT loss_minor, new_recovery, greatest(loss_minor-new_recovery,0);
END;
$$;

CREATE TRIGGER stripe_reconciliation_case_immutable
  BEFORE DELETE ON public.stripe_reconciliation_case
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_finance_reconciliation_mutation();

REVOKE ALL ON FUNCTION public.gphkm_list_open_stripe_reconciliation_snapshots() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gphkm_resolve_stripe_reconciliation_case(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gphkm_open_stripe_reconciliation_case() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gphkm_open_stripe_case_for_risky_attempt() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_list_open_stripe_reconciliation_snapshots() TO gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_resolve_stripe_reconciliation_case(text,text,text,text) TO gphkm_runtime;
