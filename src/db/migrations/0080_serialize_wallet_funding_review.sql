-- Serialize new funding attempts, order debits, Finance resolution, and
-- verified Stripe events that may open a provider-risk case.
-- This narrow function is the only runtime path that creates a funding
-- attempt. Take the advisory lock before the organization row lock, with an
-- ownership precheck to prevent unauthorized callers from locking another
-- tenant. Recheck ownership after the row lock for authority serialization.
CREATE OR REPLACE FUNCTION public.gphkm_create_stripe_topup_attempt(
  target_attempt_id text,
  target_amount_minor numeric,
  target_idempotency_key text,
  target_request_hash text
) RETURNS public.payment_attempt
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  org_id text := nullif(current_setting('app.organization_id', true), '');
  attempt_row public.payment_attempt%ROWTYPE;
BEGIN
  IF actor_id IS NULL OR org_id IS NULL OR target_attempt_id !~ '^[0-9a-f-]{36}$'
     OR target_amount_minor IS NULL OR target_amount_minor <= 0
     OR target_amount_minor <> trunc(target_amount_minor)
     OR target_amount_minor > 9007199254740991
     OR target_idempotency_key IS NULL OR length(target_idempotency_key) < 16 OR length(target_idempotency_key) > 128
     OR target_request_hash IS NULL OR target_request_hash !~ '^[0-9a-f]{64}$'
     OR NOT public.gphkm_is_active_org_owner(org_id, actor_id) THEN
    RAISE EXCEPTION 'wallet funding unavailable' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('gphkm:wallet-risk:' || org_id, 0));
  PERFORM 1 FROM public.organization WHERE id = org_id AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT public.gphkm_is_active_org_owner(org_id, actor_id) THEN
    RAISE EXCEPTION 'wallet funding unavailable' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.payment_attempt(id, organization_id, actor_user_id, provider, state, amount_minor,
    currency, idempotency_key, request_hash)
  VALUES (target_attempt_id, org_id, actor_id, 'STRIPE', 'CREATED', target_amount_minor,
    'USD', target_idempotency_key, target_request_hash)
  ON CONFLICT (organization_id, actor_user_id, idempotency_key) DO NOTHING;

  SELECT * INTO attempt_row FROM public.payment_attempt
   WHERE organization_id = org_id AND actor_user_id = actor_id AND idempotency_key = target_idempotency_key
   FOR UPDATE;
  IF NOT FOUND OR attempt_row.amount_minor <> target_amount_minor OR attempt_row.request_hash <> target_request_hash THEN
    RAISE EXCEPTION 'wallet funding idempotency conflict' USING ERRCODE = '23505';
  END IF;
  RETURN attempt_row;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_create_stripe_topup_attempt(text,numeric,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_create_stripe_topup_attempt(text,numeric,text,text) TO gphkm_runtime;

-- Keep the large, already-reviewed event processor intact. The wrapper resolves
-- the tenant without taking a row lock, serializes the transaction, then calls
-- the existing SECURITY DEFINER implementation. This avoids adding an
  -- organization-row lock after the webhook has locked a payment-attempt row.
ALTER FUNCTION public.gphkm_process_stripe_event(text,text,text,text,text,text,text,numeric,text,text,timestamptz,text,text)
  RENAME TO gphkm_process_stripe_event_unserialized;
REVOKE ALL ON FUNCTION public.gphkm_process_stripe_event_unserialized(text,text,text,text,text,text,text,numeric,text,text,timestamptz,text,text)
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
BEGIN
  -- A duplicate event-ID conflict is reconciled against the attempt already
  -- linked to the stored event, not whichever attempt the incoming payload
  -- happens to identify.
  SELECT a.organization_id INTO target_organization_id
  FROM public.provider_event e
  JOIN public.payment_attempt a ON a.id = e.payment_attempt_id
  WHERE e.provider = 'STRIPE' AND e.provider_event_id = target_event_id;

  IF target_organization_id IS NULL AND target_event_type IN (
    'checkout.session.completed', 'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed', 'checkout.session.expired'
  ) THEN
    SELECT a.organization_id INTO target_organization_id
    FROM public.payment_attempt a
    WHERE (target_attempt_id IS NOT NULL AND a.id = target_attempt_id)
       OR (target_checkout_session_id IS NOT NULL AND a.provider_checkout_session_id = target_checkout_session_id)
    ORDER BY CASE WHEN a.id = target_attempt_id THEN 0 ELSE 1 END
    LIMIT 1;
  ELSIF target_organization_id IS NULL AND target_event_type IN (
    'charge.dispute.created', 'charge.dispute.closed', 'charge.refunded'
  ) THEN
    SELECT a.organization_id INTO target_organization_id
    FROM public.payment_attempt a
    WHERE a.provider_payment_id = target_payment_intent_id
       OR (target_attempt_id IS NOT NULL AND a.id = target_attempt_id)
    ORDER BY CASE WHEN a.id = target_attempt_id THEN 0 ELSE 1 END
    LIMIT 1;
  END IF;

  IF target_organization_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('gphkm:wallet-risk:' || target_organization_id, 0));
  END IF;

  RETURN public.gphkm_process_stripe_event_unserialized(
    target_event_id, target_event_type, target_payload_hash, target_object_id,
    target_attempt_id, target_checkout_session_id, target_payment_intent_id,
    target_amount_minor, target_currency, target_payment_status, target_event_created_at,
    target_dispute_status, target_dispute_id);
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_process_stripe_event(text,text,text,text,text,text,text,numeric,text,text,timestamptz,text,text)
  FROM PUBLIC, gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_process_stripe_event(text,text,text,text,text,text,text,numeric,text,text,timestamptz,text,text)
  TO gphkm_webhook;

-- Finance resolution also updates provider_event rows. Taking the same risk
-- lock before the idempotent attempt-row lock prevents a duplicate-event
-- identity conflict (event→case) from deadlocking against Finance (case→event).
CREATE OR REPLACE FUNCTION public.gphkm_resolve_stripe_reconciliation_case(
  target_attempt_id text,
  target_snapshot_id text,
  target_evidence_reference text,
  target_reason text
) RETURNS TABLE(provider_loss_minor numeric, wallet_recovery_minor numeric, uncovered_minor numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  target_organization_id text;
  attempt_exists boolean;
  prior public.stripe_reconciliation_decision%ROWTYPE;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'FINANCE') THEN
    RAISE EXCEPTION 'Stripe reconciliation unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT organization_id INTO target_organization_id FROM public.payment_attempt
   WHERE id = target_attempt_id AND provider = 'STRIPE';
  IF target_organization_id IS NULL THEN
    RAISE EXCEPTION 'Stripe funding attempt unavailable' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('gphkm:wallet-risk:' || target_organization_id, 0));
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
