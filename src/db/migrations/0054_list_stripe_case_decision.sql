CREATE OR REPLACE FUNCTION public.gphkm_list_open_stripe_reconciliation_snapshots()
RETURNS TABLE(payment_attempt_id text, organization_id text, attempt_state text, case_id text,
  snapshot_id text, snapshot_created_at timestamptz, snapshot_complete boolean, facts jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') THEN
    RAISE EXCEPTION 'Stripe provider review unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT a.id, a.organization_id, a.state, c.id, s.id, s.created_at, s.complete,
    coalesce(s.facts, '{}'::jsonb) || jsonb_build_object('latestDecision', d.details)
  FROM public.stripe_reconciliation_case c
  JOIN public.payment_attempt a ON a.id = c.payment_attempt_id
  LEFT JOIN LATERAL (
    SELECT x.id, x.created_at, x.complete, x.facts FROM public.stripe_finance_snapshot x
    WHERE x.payment_attempt_id = a.id
      AND x.facts->>'refreshId' = (
        SELECT r.id FROM public.stripe_finance_refresh r WHERE r.payment_attempt_id = a.id
        ORDER BY r.started_at DESC, r.id DESC LIMIT 1
      )
    ORDER BY x.created_at DESC, x.id DESC LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'providerLossMinor', d.provider_loss_minor::text,
      'walletRecoveryMinor', d.wallet_recovery_minor::text,
      'uncoveredMinor', d.uncovered_minor::text,
      'evidenceReference', d.evidence_reference,
      'reason', d.reason,
      'createdAt', d.created_at
    ) AS details
    FROM public.stripe_reconciliation_decision d WHERE d.case_id = c.id
    ORDER BY d.created_at DESC, d.id DESC LIMIT 1
  ) d ON true
  WHERE c.state = 'OPEN' ORDER BY c.opened_at LIMIT 100;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_list_open_stripe_reconciliation_snapshots() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_list_open_stripe_reconciliation_snapshots() TO gphkm_runtime;
