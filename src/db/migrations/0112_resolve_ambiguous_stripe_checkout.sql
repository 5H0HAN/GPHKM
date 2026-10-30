-- Provide an evidence-based Finance path to release an open top-up after an
-- ambiguous Checkout Session create. This never writes wallet funds.
CREATE FUNCTION public.gphkm_list_ambiguous_stripe_checkout_attempts()
RETURNS TABLE(
  payment_attempt_id text,
  organization_id text,
  amount_minor numeric,
  currency text,
  created_at timestamptz,
  dispatch_started_at timestamptz,
  has_related_provider_event boolean,
  eligible_for_evidence_resolution boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF NOT (public.gphkm_is_active_staff(actor_id, 'FINANCE')
       OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')) THEN
    RAISE EXCEPTION 'wallet reconciliation unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT a.id, a.organization_id, a.amount_minor, a.currency, a.created_at,
    a.checkout_session_create_started_at,
    EXISTS (SELECT 1 FROM public.provider_event e WHERE e.payment_attempt_id = a.id),
    (a.checkout_session_create_started_at <= clock_timestamp() - interval '24 hours'
      AND NOT EXISTS (SELECT 1 FROM public.provider_event e WHERE e.payment_attempt_id = a.id))
  FROM public.payment_attempt a
  WHERE a.provider = 'STRIPE' AND a.state IN ('CREATED', 'PENDING')
    AND a.provider_checkout_session_id IS NULL
    AND a.checkout_session_create_started_at IS NOT NULL
  ORDER BY a.checkout_session_create_started_at, a.id
  LIMIT 100;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_list_ambiguous_stripe_checkout_attempts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_list_ambiguous_stripe_checkout_attempts() TO gphkm_runtime;

CREATE FUNCTION public.gphkm_resolve_missing_stripe_checkout_session(
  target_attempt_id text, target_evidence_reference text, target_reason text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  attempt_org_id text;
  attempt_row public.payment_attempt%ROWTYPE;
BEGIN
  IF NOT (public.gphkm_is_active_staff(actor_id, 'FINANCE')
       OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN'))
     OR target_attempt_id IS NULL OR target_attempt_id !~ '^[0-9a-f-]{36}$'
     OR target_evidence_reference IS NULL OR length(btrim(target_evidence_reference)) NOT BETWEEN 3 AND 200
     OR target_evidence_reference ~ '[[:cntrl:]]'
     OR target_reason IS NULL OR length(btrim(target_reason)) NOT BETWEEN 10 AND 1000
     OR target_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'wallet reconciliation unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO attempt_org_id FROM public.payment_attempt
    WHERE id = target_attempt_id AND provider = 'STRIPE';
  IF NOT FOUND THEN RAISE EXCEPTION 'checkout attempt unavailable' USING ERRCODE = '42501'; END IF;

  -- Match wallet funding's organization-before-attempt lock order.
  PERFORM 1 FROM public.organization WHERE id = attempt_org_id FOR UPDATE;
  SELECT * INTO attempt_row FROM public.payment_attempt WHERE id = target_attempt_id FOR UPDATE;
  IF NOT FOUND OR attempt_row.organization_id <> attempt_org_id
     OR attempt_row.state NOT IN ('CREATED', 'PENDING')
     OR attempt_row.provider_checkout_session_id IS NOT NULL
     OR attempt_row.provider_payment_id IS NOT NULL
     OR attempt_row.checkout_session_create_started_at IS NULL
     OR attempt_row.checkout_session_create_started_at > clock_timestamp() - interval '24 hours'
     OR EXISTS (SELECT 1 FROM public.provider_event e WHERE e.payment_attempt_id = attempt_row.id) THEN
    RAISE EXCEPTION 'checkout attempt requires provider event review or is not eligible' USING ERRCODE = '23514';
  END IF;

  UPDATE public.payment_attempt SET state = 'FAILED', updated_at = clock_timestamp()
    WHERE id = attempt_row.id;
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
  VALUES (gen_random_uuid()::text, attempt_row.organization_id, actor_id,
    'STRIPE_CHECKOUT_ABSENCE_CONFIRMED', 'PAYMENT_ATTEMPT', attempt_row.id,
    'FINANCE_VERIFIED_NO_SESSION_OR_PAYMENT', jsonb_build_object(
      'evidenceReference', btrim(target_evidence_reference),
      'reason', btrim(target_reason),
      'dispatchStartedAt', attempt_row.checkout_session_create_started_at,
      'providerSessionIdPresent', false,
      'providerPaymentIdPresent', false,
      'providerEventPresent', false
    ));
  RETURN attempt_row.id;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_resolve_missing_stripe_checkout_session(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_resolve_missing_stripe_checkout_session(text, text, text) TO gphkm_runtime;
