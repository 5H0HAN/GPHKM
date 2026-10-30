CREATE TABLE public.stripe_payout_snapshot (
  id text PRIMARY KEY,
  payout_id text NOT NULL CHECK (payout_id ~ '^po_[A-Za-z0-9]+$'),
  actor_user_id text NOT NULL REFERENCES public.auth_user(id),
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object' AND octet_length(facts::text) <= 150000),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  complete boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stripe_payout_snapshot_latest_idx ON public.stripe_payout_snapshot(payout_id, created_at DESC, id DESC);
ALTER TABLE public.stripe_payout_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stripe_payout_snapshot FROM PUBLIC, gphkm_runtime;
CREATE TRIGGER stripe_payout_snapshot_immutable BEFORE UPDATE OR DELETE ON public.stripe_payout_snapshot
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_finance_reconciliation_mutation();

CREATE TABLE public.stripe_payout_bank_review (
  id text PRIMARY KEY,
  snapshot_id text NOT NULL REFERENCES public.stripe_payout_snapshot(id),
  actor_user_id text NOT NULL REFERENCES public.auth_user(id),
  decision text NOT NULL CHECK (decision IN ('MATCHED','FOLLOW_UP_REQUIRED')),
  bank_amount_minor numeric(20,0) NOT NULL CHECK (bank_amount_minor >= 0),
  bank_currency text NOT NULL CHECK (bank_currency = 'usd'),
  bank_settled_at timestamptz,
  evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 3 AND 200),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stripe_payout_bank_review_snapshot_idx ON public.stripe_payout_bank_review(snapshot_id, created_at DESC, id DESC);
ALTER TABLE public.stripe_payout_bank_review ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stripe_payout_bank_review FROM PUBLIC, gphkm_runtime;
CREATE TRIGGER stripe_payout_bank_review_immutable BEFORE UPDATE OR DELETE ON public.stripe_payout_bank_review
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_finance_reconciliation_mutation();

CREATE FUNCTION public.gphkm_store_stripe_payout_snapshot(
  target_payout_id text, target_hash text, target_complete boolean, target_facts jsonb
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  inserted_id text := gen_random_uuid()::text;
  transaction_row jsonb;
  transactions_net numeric := 0;
  transactions_gross numeric := 0;
  transactions_fees numeric := 0;
  payout_amount numeric;
  payout_balance jsonb;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'FINANCE')
    OR target_payout_id IS NULL OR target_payout_id !~ '^po_[A-Za-z0-9]+$'
    OR target_hash IS NULL OR target_hash !~ '^[0-9a-f]{64}$'
    OR target_complete IS NULL OR target_facts IS NULL OR jsonb_typeof(target_facts) <> 'object'
    OR octet_length(target_facts::text) > 150000
    OR target_facts->>'payoutId' IS DISTINCT FROM target_payout_id
    OR coalesce(target_facts->>'providerMode','') NOT IN ('test','live')
    OR target_facts->>'currency' IS DISTINCT FROM 'usd'
    OR coalesce(target_facts->>'amountMinor','') !~ '^[0-9]+$'
    OR coalesce(target_facts->>'status','') NOT IN ('paid','pending','in_transit','canceled','failed')
    OR coalesce(target_facts->>'reconciliationStatus','') NOT IN ('completed','in_progress','not_applicable')
    OR jsonb_typeof(target_facts->'balanceTransactions') IS DISTINCT FROM 'array'
    OR target_facts ?| ARRAY['destination','description','metadata','failureCode','failureMessage','statementDescriptor'] THEN
    RAISE EXCEPTION 'Stripe payout facts invalid' USING ERRCODE = '22023';
  END IF;
  payout_amount := (target_facts->>'amountMinor')::numeric;
  IF payout_amount <= 0 THEN
    RAISE EXCEPTION 'Stripe payout amount must be positive' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(target_facts->'balanceTransactions') > 1000 THEN
    RAISE EXCEPTION 'Stripe payout transaction list exceeds limit' USING ERRCODE = '22023';
  END IF;

  IF target_complete AND target_facts->>'reconciliationStatus' = 'completed' THEN
    IF target_facts->>'transactionsComplete' IS DISTINCT FROM 'true'
      OR coalesce(target_facts->>'transactionsNetMinor','') !~ '^-?[0-9]+$' THEN
      RAISE EXCEPTION 'Stripe payout transaction retrieval is incomplete' USING ERRCODE = '23514';
    END IF;
    FOR transaction_row IN SELECT value FROM jsonb_array_elements(target_facts->'balanceTransactions') AS value LOOP
      IF jsonb_typeof(transaction_row) IS DISTINCT FROM 'object'
        OR transaction_row - ARRAY['id','amountMinor','feeMinor','netMinor','currency','type','status'] <> '{}'::jsonb
        OR coalesce(transaction_row->>'id','') !~ '^txn_[A-Za-z0-9]+$'
        OR coalesce(transaction_row->>'amountMinor','') !~ '^-?[0-9]+$'
        OR coalesce(transaction_row->>'feeMinor','') !~ '^[0-9]+$'
        OR jsonb_typeof(transaction_row->'netMinor') IS DISTINCT FROM 'string'
        OR coalesce(transaction_row->>'netMinor','') !~ '^-?[0-9]+$'
        OR transaction_row->>'currency' IS DISTINCT FROM 'usd' THEN
        RAISE EXCEPTION 'Stripe payout balance transaction facts are invalid' USING ERRCODE = '23514';
      END IF;
      IF (transaction_row->>'netMinor')::numeric <> (transaction_row->>'amountMinor')::numeric - (transaction_row->>'feeMinor')::numeric THEN
        RAISE EXCEPTION 'Stripe balance transaction gross, fee, and net are inconsistent' USING ERRCODE = '23514';
      END IF;
      transactions_gross := transactions_gross + (transaction_row->>'amountMinor')::numeric;
      transactions_fees := transactions_fees + (transaction_row->>'feeMinor')::numeric;
      transactions_net := transactions_net + (transaction_row->>'netMinor')::numeric;
    END LOOP;
    IF transactions_net <> payout_amount
      OR coalesce(target_facts->>'transactionsGrossMinor','') !~ '^-?[0-9]+$'
      OR coalesce(target_facts->>'transactionsFeeMinor','') !~ '^[0-9]+$'
      OR (target_facts->>'transactionsGrossMinor')::numeric <> transactions_gross
      OR (target_facts->>'transactionsFeeMinor')::numeric <> transactions_fees
      OR (target_facts->>'transactionsNetMinor')::numeric <> transactions_net THEN
      RAISE EXCEPTION 'Stripe payout balance transactions do not sum to the payout' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF target_complete AND target_facts->>'status' = 'paid' THEN
    payout_balance := target_facts->'payoutBalanceTransaction';
    IF jsonb_typeof(payout_balance) IS DISTINCT FROM 'object'
      OR payout_balance - ARRAY['id','amountMinor','feeMinor','netMinor','currency','type','status'] <> '{}'::jsonb
      OR coalesce(payout_balance->>'id','') !~ '^txn_[A-Za-z0-9]+$'
      OR coalesce(payout_balance->>'amountMinor','') !~ '^-?[0-9]+$'
      OR coalesce(payout_balance->>'feeMinor','') !~ '^[0-9]+$'
      OR coalesce(payout_balance->>'netMinor','') !~ '^-?[0-9]+$'
      OR payout_balance->>'currency' IS DISTINCT FROM 'usd'
      OR payout_balance->>'type' IS DISTINCT FROM 'payout'
      OR (payout_balance->>'netMinor')::numeric <> (payout_balance->>'amountMinor')::numeric - (payout_balance->>'feeMinor')::numeric
      OR (payout_balance->>'amountMinor')::numeric <> -payout_amount
      OR (payout_balance->>'netMinor')::numeric <> -payout_amount THEN
      RAISE EXCEPTION 'Paid Stripe payout has no matching payout balance transaction' USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO public.stripe_payout_snapshot(id, payout_id, actor_user_id, facts, payload_hash, complete)
    VALUES (inserted_id, target_payout_id, actor_id, target_facts, target_hash, target_complete);
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, NULL, actor_id, 'STRIPE_PAYOUT_FACTS_REFRESHED', 'STRIPE_PAYOUT', target_payout_id,
      CASE WHEN target_complete THEN 'PROVIDER_FACTS_COMPLETE' ELSE 'PROVIDER_FACTS_INCOMPLETE' END,
      jsonb_build_object('snapshotId', inserted_id, 'payloadHash', target_hash,
        'balanceTransactionCount', jsonb_array_length(target_facts->'balanceTransactions')));
  RETURN inserted_id;
END;
$$;

CREATE FUNCTION public.gphkm_record_stripe_payout_bank_review(
  target_snapshot_id text, target_decision text, target_bank_amount numeric,
  target_bank_currency text, target_bank_settled_at timestamptz,
  target_evidence_reference text, target_reason text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  snapshot_row public.stripe_payout_snapshot%ROWTYPE;
  inserted_id text := gen_random_uuid()::text;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'FINANCE')
    OR target_snapshot_id IS NULL OR target_snapshot_id !~ '^[0-9a-f-]{36}$'
    OR target_decision NOT IN ('MATCHED','FOLLOW_UP_REQUIRED')
    OR target_bank_amount IS NULL OR target_bank_amount < 0 OR target_bank_amount <> trunc(target_bank_amount)
    OR target_bank_currency IS DISTINCT FROM 'usd'
    OR target_evidence_reference IS NULL OR length(btrim(target_evidence_reference)) NOT BETWEEN 3 AND 200
    OR target_evidence_reference ~ '[[:cntrl:]]'
    OR target_reason IS NULL OR length(btrim(target_reason)) NOT BETWEEN 10 AND 1000
    OR target_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Stripe payout bank review invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO snapshot_row FROM public.stripe_payout_snapshot s
    WHERE s.id = target_snapshot_id FOR SHARE;
  IF NOT FOUND OR snapshot_row.id IS DISTINCT FROM (
    SELECT s.id FROM public.stripe_payout_snapshot s WHERE s.payout_id = snapshot_row.payout_id
    ORDER BY s.created_at DESC, s.id DESC LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Stripe payout snapshot is no longer current' USING ERRCODE = '23514';
  END IF;
  IF target_decision = 'MATCHED' AND (
    snapshot_row.complete IS NOT TRUE OR snapshot_row.facts->>'status' IS DISTINCT FROM 'paid'
    OR target_bank_amount <> (snapshot_row.facts->>'amountMinor')::numeric
    OR target_bank_currency IS DISTINCT FROM snapshot_row.facts->>'currency'
    OR target_bank_settled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Payout cannot be matched to the submitted bank evidence' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.stripe_payout_bank_review(id, snapshot_id, actor_user_id, decision, bank_amount_minor,
    bank_currency, bank_settled_at, evidence_reference, reason)
    VALUES (inserted_id, target_snapshot_id, actor_id, target_decision, target_bank_amount,
      target_bank_currency, target_bank_settled_at, btrim(target_evidence_reference), btrim(target_reason));
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, NULL, actor_id, 'STRIPE_PAYOUT_BANK_REVIEWED', 'STRIPE_PAYOUT', snapshot_row.payout_id,
      target_decision, jsonb_build_object('snapshotId', target_snapshot_id, 'reviewId', inserted_id,
        'bankAmountMinor', target_bank_amount::text, 'bankCurrency', target_bank_currency,
        'bankSettledAt', target_bank_settled_at, 'evidenceReference', btrim(target_evidence_reference)));
  RETURN inserted_id;
END;
$$;

CREATE FUNCTION public.gphkm_list_stripe_payout_reconciliation()
RETURNS TABLE(snapshot_id text, payout_id text, snapshot_created_at timestamptz, snapshot_complete boolean, facts jsonb, latest_review jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') THEN
    RAISE EXCEPTION 'Stripe payout review unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT s.id, s.payout_id, s.created_at, s.complete, s.facts,
    (SELECT jsonb_build_object('decision', r.decision, 'bankAmountMinor', r.bank_amount_minor::text,
      'bankCurrency', r.bank_currency, 'bankSettledAt', r.bank_settled_at,
      'evidenceReference', r.evidence_reference, 'reason', r.reason, 'actorUserId', r.actor_user_id,
      'createdAt', r.created_at)
      FROM public.stripe_payout_bank_review r WHERE r.snapshot_id = s.id
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1)
  FROM public.stripe_payout_snapshot s
  WHERE s.id = (SELECT current_snapshot.id FROM public.stripe_payout_snapshot current_snapshot
    WHERE current_snapshot.payout_id = s.payout_id ORDER BY current_snapshot.created_at DESC, current_snapshot.id DESC LIMIT 1)
  ORDER BY s.created_at DESC LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION public.gphkm_store_stripe_payout_snapshot(text,text,boolean,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gphkm_record_stripe_payout_bank_review(text,text,numeric,text,timestamptz,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gphkm_list_stripe_payout_reconciliation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_store_stripe_payout_snapshot(text,text,boolean,jsonb) TO gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_record_stripe_payout_bank_review(text,text,numeric,text,timestamptz,text,text) TO gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_list_stripe_payout_reconciliation() TO gphkm_runtime;
