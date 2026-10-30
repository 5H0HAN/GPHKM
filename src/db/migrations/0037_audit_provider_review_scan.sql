CREATE OR REPLACE FUNCTION public.gphkm_add_stripe_provider_review_findings(target_run_id text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  inserted_count integer;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'FINANCE')
     OR target_run_id IS NULL OR target_run_id !~ '^[0-9a-f-]{36}$'
     OR NOT EXISTS (SELECT 1 FROM public.finance_reconciliation_run r
       WHERE r.id = target_run_id AND r.actor_user_id = actor_id) THEN
    RAISE EXCEPTION 'provider event reconciliation unavailable' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.finance_reconciliation_finding(id, run_id, owner_user_id, organization_id,
    fingerprint, category, target_type, target_id, expected_minor, observed_minor, summary)
  SELECT gen_random_uuid()::text, target_run_id, actor_id, a.organization_id,
    'stripe-event:' || e.provider_event_id, 'STRIPE_PROVIDER_EVENT_REVIEW', 'PROVIDER_EVENT', e.provider_event_id,
    a.amount_minor, e.provider_amount_minor,
    CASE WHEN e.event_type = 'charge.refunded'
      THEN 'Stripe charge refund amount is cumulative; reconcile the current refund objects and linked wallet exposure.'
      ELSE 'Verified Stripe event needs provider-side reconciliation before any financial resolution.'
    END
  FROM public.provider_event e
  LEFT JOIN public.payment_attempt a ON a.id = e.payment_attempt_id
  WHERE e.provider = 'STRIPE'
    AND (e.state = 'RECONCILIATION_REQUIRED' OR e.event_type = 'charge.refunded')
  ON CONFLICT (run_id, fingerprint) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  INSERT INTO public.audit_event(id, actor_user_id, action, target_type, target_id, reason_code, metadata)
  VALUES (gen_random_uuid()::text, actor_id, 'STRIPE_PROVIDER_REVIEW_SCAN',
    'FINANCE_RECONCILIATION_RUN', target_run_id, 'READ_ONLY_PROVIDER_EVENT_REVIEW',
    jsonb_build_object('findingCount', inserted_count));
  RETURN inserted_count;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_add_stripe_provider_review_findings(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_add_stripe_provider_review_findings(text) TO gphkm_runtime;
