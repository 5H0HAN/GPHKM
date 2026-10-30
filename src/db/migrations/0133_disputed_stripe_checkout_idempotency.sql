-- A delayed Checkout Session success can arrive after the same PaymentIntent
-- has already been settled and moved to DISPUTED. Record a matching event
-- without re-entering the original settlement branch (which would attempt a
-- second wallet ledger credit). Contradictory facts enter normal reconciliation.
ALTER FUNCTION public.gphkm_process_stripe_event(text,text,text,text,text,text,text,numeric,text,text,timestamptz,text,text)
  RENAME TO gphkm_process_stripe_event_before_disputed_idempotency;
REVOKE ALL ON FUNCTION public.gphkm_process_stripe_event_before_disputed_idempotency(text,text,text,text,text,text,text,numeric,text,text,timestamptz,text,text)
  FROM PUBLIC, gphkm_runtime, gphkm_webhook;

CREATE FUNCTION public.gphkm_process_stripe_event(
  target_event_id text,
  target_event_type text,
  target_payload_hash text,
  target_object_id text,
  target_attempt_id text,
  target_checkout_session_id text,
  target_payment_intent_id text,
  target_amount_minor numeric,
  target_currency text,
  target_payment_status text,
  target_event_created_at timestamptz,
  target_dispute_status text,
  target_dispute_id text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public SET TimeZone = 'UTC' AS $$
DECLARE
  target_organization_id text;
  attempt_row public.payment_attempt%ROWTYPE;
  event_row public.provider_event%ROWTYPE;
  event_result text;
  event_inserted integer;
  session_matches boolean;
  ledger_matches boolean;
BEGIN
  IF target_event_type NOT IN ('checkout.session.completed','checkout.session.async_payment_succeeded')
     OR target_payment_status <> 'paid' THEN
    RETURN public.gphkm_process_stripe_event_before_disputed_idempotency(
      target_event_id, target_event_type, target_payload_hash, target_object_id,
      target_attempt_id, target_checkout_session_id, target_payment_intent_id,
      target_amount_minor, target_currency, target_payment_status, target_event_created_at,
      target_dispute_status, target_dispute_id);
  END IF;

  SELECT a.organization_id INTO target_organization_id
  FROM public.provider_event e JOIN public.payment_attempt a ON a.id = e.payment_attempt_id
  WHERE e.provider = 'STRIPE' AND e.provider_event_id = target_event_id;
  IF target_organization_id IS NULL THEN
    SELECT a.organization_id INTO target_organization_id FROM public.payment_attempt a
    WHERE (target_attempt_id IS NOT NULL AND a.id = target_attempt_id)
       OR (target_checkout_session_id IS NOT NULL AND a.provider_checkout_session_id = target_checkout_session_id)
    ORDER BY CASE WHEN a.id = target_attempt_id THEN 0 ELSE 1 END LIMIT 1;
  END IF;
  IF target_organization_id IS NULL THEN
    RETURN public.gphkm_process_stripe_event_before_disputed_idempotency(
      target_event_id, target_event_type, target_payload_hash, target_object_id,
      target_attempt_id, target_checkout_session_id, target_payment_intent_id,
      target_amount_minor, target_currency, target_payment_status, target_event_created_at,
      target_dispute_status, target_dispute_id);
  END IF;

  -- Preserve the same organization risk-lock order used by webhook processing
  -- and Finance decisions before locking event or attempt rows.
  PERFORM pg_advisory_xact_lock(hashtextextended('gphkm:wallet-risk:' || target_organization_id, 0));
  SELECT * INTO event_row FROM public.provider_event
    WHERE provider = 'STRIPE' AND provider_event_id = target_event_id FOR UPDATE;
  IF FOUND THEN
    RETURN public.gphkm_process_stripe_event_before_disputed_idempotency(
      target_event_id, target_event_type, target_payload_hash, target_object_id,
      target_attempt_id, target_checkout_session_id, target_payment_intent_id,
      target_amount_minor, target_currency, target_payment_status, target_event_created_at,
      target_dispute_status, target_dispute_id);
  END IF;

  SELECT * INTO attempt_row FROM public.payment_attempt a
  WHERE (target_attempt_id IS NOT NULL AND a.id = target_attempt_id)
     OR (target_checkout_session_id IS NOT NULL AND a.provider_checkout_session_id = target_checkout_session_id)
  ORDER BY CASE WHEN a.id = target_attempt_id THEN 0 ELSE 1 END LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.gphkm_process_stripe_event_before_disputed_idempotency(
      target_event_id, target_event_type, target_payload_hash, target_object_id,
      target_attempt_id, target_checkout_session_id, target_payment_intent_id,
      target_amount_minor, target_currency, target_payment_status, target_event_created_at,
      target_dispute_status, target_dispute_id);
  END IF;

  session_matches := target_checkout_session_id IS NOT NULL AND (
    attempt_row.provider_checkout_session_id = target_checkout_session_id
    OR (attempt_row.provider_checkout_session_id IS NULL AND target_attempt_id = attempt_row.id));
  IF attempt_row.state <> 'DISPUTED' OR NOT session_matches THEN
    RETURN public.gphkm_process_stripe_event_before_disputed_idempotency(
      target_event_id, target_event_type, target_payload_hash, target_object_id,
      target_attempt_id, target_checkout_session_id, target_payment_intent_id,
      target_amount_minor, target_currency, target_payment_status, target_event_created_at,
      target_dispute_status, target_dispute_id);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.wallet_ledger_entry l
    WHERE l.organization_id = attempt_row.organization_id AND l.operation = 'STRIPE_TOP_UP'
      AND l.idempotency_key = attempt_row.id AND l.kind = 'TOP_UP'
      AND l.delta_minor = attempt_row.amount_minor AND l.currency = attempt_row.currency
  ) INTO ledger_matches;
  IF attempt_row.provider_payment_id = target_payment_intent_id
     AND target_payment_intent_id IS NOT NULL
     AND target_amount_minor = attempt_row.amount_minor
     AND lower(target_currency) = lower(attempt_row.currency)
     AND ledger_matches THEN
    event_result := 'PROCESSED';
  ELSE
    event_result := 'RECONCILIATION_REQUIRED';
  END IF;

  INSERT INTO public.provider_event(id, provider, provider_event_id, event_type, provider_object_id,
    related_payment_id, state, payload_hash, payment_attempt_id, processed_at)
  VALUES (gen_random_uuid()::text, 'STRIPE', target_event_id, target_event_type, target_object_id,
    target_payment_intent_id, event_result, target_payload_hash, attempt_row.id, clock_timestamp())
  ON CONFLICT (provider, provider_event_id) DO NOTHING;
  GET DIAGNOSTICS event_inserted = ROW_COUNT;
  IF event_inserted = 0 THEN
    RETURN public.gphkm_process_stripe_event_before_disputed_idempotency(
      target_event_id, target_event_type, target_payload_hash, target_object_id,
      target_attempt_id, target_checkout_session_id, target_payment_intent_id,
      target_amount_minor, target_currency, target_payment_status, target_event_created_at,
      target_dispute_status, target_dispute_id);
  END IF;

  IF event_result = 'RECONCILIATION_REQUIRED' THEN
    INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id,
      reason_code, metadata)
    VALUES (gen_random_uuid()::text, attempt_row.organization_id, NULL,
      'STRIPE_DISPUTED_CHECKOUT_SUCCESS_CONFLICT', 'PAYMENT_ATTEMPT', attempt_row.id,
      'DISPUTED_SUCCESS_FACTS_REQUIRE_REVIEW', jsonb_build_object(
        'eventId', target_event_id, 'eventType', target_event_type,
        'paymentIntentMatches', attempt_row.provider_payment_id = target_payment_intent_id,
        'amountMatches', target_amount_minor = attempt_row.amount_minor,
        'currencyMatches', lower(target_currency) = lower(attempt_row.currency),
        'ledgerMatches', ledger_matches));
  END IF;
  RETURN event_result;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_process_stripe_event(text,text,text,text,text,text,text,numeric,text,text,timestamptz,text,text)
  FROM PUBLIC, gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_process_stripe_event(text,text,text,text,text,text,text,numeric,text,text,timestamptz,text,text)
  TO gphkm_webhook;
