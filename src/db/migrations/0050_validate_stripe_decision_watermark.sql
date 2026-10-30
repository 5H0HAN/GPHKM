CREATE FUNCTION public.gphkm_validate_stripe_reconciliation_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  attempt_row public.payment_attempt%ROWTYPE;
  snapshot_row public.stripe_finance_snapshot%ROWTYPE;
  refresh_row public.stripe_finance_refresh%ROWTYPE;
  net_principal_loss numeric;
BEGIN
  SELECT a.* INTO attempt_row
    FROM public.stripe_reconciliation_case c
    JOIN public.payment_attempt a ON a.id = c.payment_attempt_id
   WHERE c.id = NEW.case_id AND c.state = 'OPEN' FOR UPDATE OF a;
  SELECT * INTO snapshot_row FROM public.stripe_finance_snapshot WHERE id = NEW.snapshot_id;
  SELECT * INTO refresh_row FROM public.stripe_finance_refresh WHERE id = snapshot_row.facts->>'refreshId';
  IF attempt_row.id IS NULL OR snapshot_row.id IS NULL OR refresh_row.id IS NULL
     OR snapshot_row.payment_attempt_id <> attempt_row.id OR refresh_row.payment_attempt_id <> attempt_row.id
     OR NOT snapshot_row.complete OR snapshot_row.facts->>'detailComplete' IS DISTINCT FROM 'true'
     OR snapshot_row.facts->>'paginationComplete' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Complete refreshed Stripe evidence is required' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.provider_event e
    WHERE e.payment_attempt_id = attempt_row.id AND e.received_at > refresh_row.started_at) THEN
    RAISE EXCEPTION 'Stripe events arrived after this provider refresh began; refresh again' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot_row.facts->'refunds') r
    WHERE r->>'status' = 'succeeded'
      AND ((r->'balanceTransaction'->>'amountMinor')::numeric <> -((r->>'amountMinor')::numeric)
        OR r->'balanceTransaction'->>'currency' IS DISTINCT FROM lower(attempt_row.currency)
        OR r->'balanceTransaction'->>'status' IS DISTINCT FROM 'available')) THEN
    RAISE EXCEPTION 'Stripe refund and balance transaction principal do not match' USING ERRCODE = '23514';
  END IF;
  WITH provider_transactions AS (
    SELECT (r->'balanceTransaction'->>'amountMinor')::numeric AS amount_minor
      FROM jsonb_array_elements(snapshot_row.facts->'refunds') r WHERE r->>'status' = 'succeeded'
    UNION ALL
    SELECT (bt->>'amountMinor')::numeric
      FROM jsonb_array_elements(snapshot_row.facts->'disputes') d
      CROSS JOIN LATERAL jsonb_array_elements(d->'balanceTransactions') bt
  )
  SELECT greatest(-coalesce(sum(amount_minor),0),0) INTO net_principal_loss FROM provider_transactions;
  IF net_principal_loss > attempt_row.amount_minor THEN
    RAISE EXCEPTION 'Provider principal loss exceeds the original top-up; manual investigation required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_validate_stripe_reconciliation_decision() FROM PUBLIC;
CREATE TRIGGER stripe_reconciliation_decision_validate_evidence
  BEFORE INSERT ON public.stripe_reconciliation_decision
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_validate_stripe_reconciliation_decision();
