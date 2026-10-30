-- Stripe wallet top-ups. Runtime may invoke only these narrow, owner-checked
-- commands; it receives no direct write access to payment, event, grant, hold,
-- or ledger rows. The webhook application verifies Stripe signatures first.
ALTER TABLE payment_attempt
  ADD COLUMN provider_checkout_session_id text UNIQUE;
ALTER TABLE provider_event
  ADD COLUMN event_type text NOT NULL DEFAULT 'legacy.unknown',
  ADD COLUMN provider_object_id text,
  ADD COLUMN related_payment_id text;

CREATE UNIQUE INDEX payment_attempt_one_open_topup_per_org
  ON payment_attempt(organization_id)
  WHERE state IN ('CREATED', 'PENDING');

CREATE INDEX provider_event_attempt_received_idx
  ON provider_event(payment_attempt_id, received_at);
CREATE INDEX provider_event_related_payment_idx ON provider_event(related_payment_id);
CREATE UNIQUE INDEX wallet_hold_one_active_provider_hold
  ON wallet_hold(payment_attempt_id)
  WHERE payment_attempt_id IS NOT NULL AND state = 'ACTIVE' AND reason_code IN ('STRIPE_DISPUTE', 'STRIPE_REFUND');

CREATE TABLE stripe_dispute_state (
  provider_dispute_id text PRIMARY KEY,
  payment_attempt_id text NOT NULL REFERENCES payment_attempt(id),
  state text NOT NULL CHECK (state IN ('OPEN', 'WON', 'LOST')),
  last_event_created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE stripe_dispute_state ENABLE ROW LEVEL SECURITY;
CREATE INDEX stripe_dispute_attempt_idx ON stripe_dispute_state(payment_attempt_id, state);
REVOKE ALL ON stripe_dispute_state FROM PUBLIC, gphkm_runtime;

CREATE FUNCTION public.gphkm_create_stripe_topup_attempt(
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
     OR target_request_hash !~ '^[0-9a-f]{64}$'
     OR NOT public.gphkm_is_active_org_owner(org_id, actor_id) THEN
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
REVOKE ALL ON FUNCTION public.gphkm_create_stripe_topup_attempt(text, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_create_stripe_topup_attempt(text, numeric, text, text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_attach_stripe_checkout_session(
  target_attempt_id text,
  target_checkout_session_id text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  attempt_row public.payment_attempt%ROWTYPE;
BEGIN
  SELECT * INTO attempt_row FROM public.payment_attempt
   WHERE id = target_attempt_id FOR UPDATE;
  IF NOT FOUND OR attempt_row.organization_id <> nullif(current_setting('app.organization_id', true), '')
     OR attempt_row.actor_user_id <> nullif(current_setting('app.user_id', true), '')
     OR NOT public.gphkm_is_active_org_owner(attempt_row.organization_id, attempt_row.actor_user_id)
     OR target_checkout_session_id IS NULL OR target_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$' THEN
    RAISE EXCEPTION 'wallet funding unavailable' USING ERRCODE = '42501';
  END IF;
  IF attempt_row.provider_checkout_session_id IS NOT NULL
     AND attempt_row.provider_checkout_session_id <> target_checkout_session_id THEN
    RAISE EXCEPTION 'wallet funding session conflict' USING ERRCODE = '23505';
  END IF;
  IF attempt_row.state NOT IN ('CREATED', 'PENDING') THEN
    RAISE EXCEPTION 'wallet funding is no longer pending' USING ERRCODE = '23514';
  END IF;
  UPDATE public.payment_attempt SET provider_checkout_session_id = target_checkout_session_id,
    state = 'PENDING', updated_at = now() WHERE id = attempt_row.id;
  RETURN attempt_row.id;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_attach_stripe_checkout_session(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_attach_stripe_checkout_session(text, text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_fail_stripe_topup_attempt(target_attempt_id text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE attempt_row public.payment_attempt%ROWTYPE;
BEGIN
  SELECT * INTO attempt_row FROM public.payment_attempt WHERE id = target_attempt_id FOR UPDATE;
  IF NOT FOUND OR attempt_row.organization_id <> nullif(current_setting('app.organization_id', true), '')
     OR attempt_row.actor_user_id <> nullif(current_setting('app.user_id', true), '')
     OR NOT public.gphkm_is_active_org_owner(attempt_row.organization_id, attempt_row.actor_user_id) THEN
    RAISE EXCEPTION 'wallet funding unavailable' USING ERRCODE = '42501';
  END IF;
  IF attempt_row.state = 'CREATED' AND attempt_row.provider_checkout_session_id IS NULL THEN
    UPDATE public.payment_attempt SET state = 'FAILED', updated_at = now() WHERE id = attempt_row.id;
    INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, attempt_row.organization_id, attempt_row.actor_user_id,
      'WALLET_TOPUP_CREATION_FAILED', 'PAYMENT_ATTEMPT', attempt_row.id, 'STRIPE_DEFINITIVE_CREATE_FAILURE',
      jsonb_build_object('provider', 'STRIPE'));
  END IF;
  RETURN attempt_row.id;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_fail_stripe_topup_attempt(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_fail_stripe_topup_attempt(text) TO gphkm_runtime;

-- This function accepts only a small normalized allowlist from the signature-
-- verified webhook handler. It performs no caller-selected ledger operation.
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  event_row public.provider_event%ROWTYPE;
  attempt_row public.payment_attempt%ROWTYPE;
  ledger_row public.wallet_ledger_entry%ROWTYPE;
  policy_row public.access_policy%ROWTYPE;
  grant_row public.access_grant%ROWTYPE;
  wallet_minor numeric(20,0);
  held_minor numeric(20,0);
  hold_minor numeric(20,0);
  settle_time timestamptz;
  grant_start timestamptz;
  grant_end timestamptz;
  latest_expiry timestamptz;
  has_active_unrestricted boolean;
  dispute_state text;
  incoming_dispute_state text;
  any_open_dispute boolean;
  any_lost_dispute boolean;
  any_refund boolean;
  event_is_stale boolean := false;
  final_attempt_state text;
  final_grant_state text;
  ledger_id text;
  result_code text := 'PROCESSED';
  event_inserted integer;
BEGIN
  IF target_event_id IS NULL OR target_event_id !~ '^evt_[A-Za-z0-9_]+$'
     OR target_payload_hash !~ '^[0-9a-f]{64}$' OR target_event_type IS NULL
     OR target_event_created_at IS NULL THEN
    RAISE EXCEPTION 'invalid Stripe event facts' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.provider_event(id, provider, provider_event_id, event_type, provider_object_id,
    related_payment_id, state, payload_hash, payment_attempt_id)
  VALUES (gen_random_uuid()::text, 'STRIPE', target_event_id, target_event_type, target_object_id,
    target_payment_intent_id, 'VERIFIED', target_payload_hash, NULL)
  ON CONFLICT (provider, provider_event_id) DO NOTHING;
  GET DIAGNOSTICS event_inserted = ROW_COUNT;
  IF event_inserted = 0 THEN
    SELECT * INTO event_row FROM public.provider_event
     WHERE provider = 'STRIPE' AND provider_event_id = target_event_id FOR UPDATE;
    IF event_row.payload_hash <> target_payload_hash OR event_row.event_type <> target_event_type THEN
      UPDATE public.provider_event SET state = 'RECONCILIATION_REQUIRED'
       WHERE provider = 'STRIPE' AND provider_event_id = target_event_id;
      INSERT INTO public.audit_event(id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (gen_random_uuid()::text, NULL, 'STRIPE_EVENT_IDENTITY_CONFLICT', 'PROVIDER_EVENT', target_event_id,
        jsonb_build_object('storedHash', event_row.payload_hash, 'observedHash', target_payload_hash, 'eventType', target_event_type));
      RETURN 'RECONCILIATION_REQUIRED';
    END IF;
    RETURN 'DUPLICATE';
  END IF;

  IF target_event_type IN ('checkout.session.completed', 'checkout.session.async_payment_succeeded',
                           'checkout.session.async_payment_failed', 'checkout.session.expired') THEN
    SELECT * INTO attempt_row FROM public.payment_attempt
     WHERE (target_attempt_id IS NOT NULL AND id = target_attempt_id)
        OR (target_checkout_session_id IS NOT NULL AND provider_checkout_session_id = target_checkout_session_id)
     ORDER BY CASE WHEN id = target_attempt_id THEN 0 ELSE 1 END
     LIMIT 1 FOR UPDATE;
    IF NOT FOUND OR (target_checkout_session_id IS NULL) OR
       (attempt_row.provider_checkout_session_id IS NOT NULL AND attempt_row.provider_checkout_session_id <> target_checkout_session_id) OR
       (attempt_row.provider_checkout_session_id IS NULL AND target_attempt_id IS DISTINCT FROM attempt_row.id) THEN
      result_code := 'RECONCILIATION_REQUIRED';
    ELSE
      UPDATE public.provider_event SET payment_attempt_id = attempt_row.id
       WHERE provider = 'STRIPE' AND provider_event_id = target_event_id;
      IF attempt_row.provider_checkout_session_id IS NULL THEN
        UPDATE public.payment_attempt SET provider_checkout_session_id = target_checkout_session_id
         WHERE id = attempt_row.id;
      END IF;
      IF target_event_type = 'checkout.session.expired' THEN
        IF attempt_row.state IN ('CREATED', 'PENDING') THEN
          UPDATE public.payment_attempt SET state = 'CANCELED', updated_at = now() WHERE id = attempt_row.id;
        END IF;
      ELSIF target_event_type = 'checkout.session.async_payment_failed' THEN
        IF attempt_row.state IN ('CREATED', 'PENDING') THEN
          UPDATE public.payment_attempt SET state = 'FAILED', updated_at = now() WHERE id = attempt_row.id;
        END IF;
      ELSIF target_payment_status <> 'paid' THEN
        IF attempt_row.state IN ('CREATED', 'PENDING') THEN
          UPDATE public.payment_attempt SET state = 'PENDING', updated_at = now() WHERE id = attempt_row.id;
        END IF;
      ELSIF target_currency <> 'usd' OR target_amount_minor IS DISTINCT FROM attempt_row.amount_minor
         OR target_payment_intent_id IS NULL OR target_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$' THEN
        result_code := 'RECONCILIATION_REQUIRED';
      ELSIF attempt_row.state = 'REVERSED' THEN
        result_code := 'RECONCILIATION_REQUIRED';
      ELSIF attempt_row.provider_payment_id IS NOT NULL AND attempt_row.provider_payment_id <> target_payment_intent_id THEN
        result_code := 'RECONCILIATION_REQUIRED';
      ELSIF attempt_row.state <> 'SETTLED' THEN
        settle_time := least(target_event_created_at, now());
        SELECT EXISTS (SELECT 1 FROM public.stripe_dispute_state WHERE payment_attempt_id = attempt_row.id AND state = 'OPEN'),
               EXISTS (SELECT 1 FROM public.stripe_dispute_state WHERE payment_attempt_id = attempt_row.id AND state = 'LOST'),
               EXISTS (SELECT 1 FROM public.provider_event WHERE payment_attempt_id = attempt_row.id
                 AND related_payment_id = target_payment_intent_id AND event_type = 'charge.refunded')
          INTO any_open_dispute, any_lost_dispute, any_refund;
        final_attempt_state := CASE WHEN any_lost_dispute OR any_refund THEN 'REVERSED'
          WHEN any_open_dispute THEN 'DISPUTED' ELSE 'SETTLED' END;
        final_grant_state := CASE WHEN final_attempt_state = 'REVERSED' THEN 'REVOKED'
          WHEN final_attempt_state = 'DISPUTED' THEN 'SUSPENDED' ELSE 'ACTIVE' END;
        IF final_attempt_state = 'REVERSED' THEN result_code := 'RECONCILIATION_REQUIRED'; END IF;
        SELECT * INTO policy_row FROM public.access_policy WHERE id = 1 FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'access policy unavailable' USING ERRCODE = '23514';
        END IF;
        SELECT balance_minor INTO wallet_minor FROM public.wallet_account
         WHERE organization_id = attempt_row.organization_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'wallet unavailable' USING ERRCODE = '23514'; END IF;
        ledger_id := gen_random_uuid()::text;
        INSERT INTO public.wallet_ledger_entry(id, organization_id, actor_user_id, kind, delta_minor,
          currency, operation, idempotency_key, related_type, related_id, reason_code)
        VALUES (ledger_id, attempt_row.organization_id, attempt_row.actor_user_id, 'TOP_UP',
          attempt_row.amount_minor, 'USD', 'STRIPE_TOP_UP', attempt_row.id,
          'PAYMENT_ATTEMPT', attempt_row.id, 'STRIPE_SETTLED');
        UPDATE public.payment_attempt SET state = final_attempt_state, provider_payment_id = target_payment_intent_id,
          settled_at = settle_time, updated_at = now() WHERE id = attempt_row.id;
        IF attempt_row.amount_minor >= policy_row.minimum_minor THEN
          SELECT coalesce(max(ends_at), NULL) INTO latest_expiry FROM public.access_grant
           WHERE organization_id = attempt_row.organization_id AND ends_at IS NOT NULL;
          SELECT EXISTS (SELECT 1 FROM public.access_grant WHERE organization_id = attempt_row.organization_id
            AND duration = 'UNRESTRICTED' AND state = 'ACTIVE' AND starts_at <= settle_time) INTO has_active_unrestricted;
          IF policy_row.duration = 'UNRESTRICTED' THEN
            grant_start := settle_time;
            grant_end := NULL;
          ELSE
            grant_start := CASE WHEN has_active_unrestricted OR latest_expiry IS NULL OR latest_expiry < settle_time
              THEN settle_time ELSE latest_expiry END;
            grant_end := grant_start + CASE policy_row.duration WHEN 'SIX_MONTHS' THEN interval '6 months' ELSE interval '12 months' END;
          END IF;
          INSERT INTO public.access_grant(id, organization_id, ledger_entry_id, policy_version, duration,
            state, starts_at, ends_at, suspension_reason)
          VALUES (gen_random_uuid()::text, attempt_row.organization_id, ledger_id, policy_row.version,
            policy_row.duration, final_grant_state, grant_start, grant_end,
            CASE WHEN final_grant_state = 'SUSPENDED' THEN 'STRIPE_DISPUTE'
              WHEN final_grant_state = 'REVOKED' THEN 'STRIPE_REVERSAL' ELSE NULL END);
        END IF;
        IF final_attempt_state IN ('DISPUTED', 'REVERSED') THEN
          SELECT balance_minor INTO wallet_minor FROM public.wallet_account
           WHERE organization_id = attempt_row.organization_id FOR UPDATE;
          SELECT coalesce(sum(amount_minor), 0) INTO held_minor FROM public.wallet_hold
           WHERE organization_id = attempt_row.organization_id AND state = 'ACTIVE';
          hold_minor := greatest(wallet_minor - held_minor, 0);
          IF hold_minor > 0 AND NOT EXISTS (SELECT 1 FROM public.wallet_hold WHERE payment_attempt_id = attempt_row.id AND state = 'ACTIVE') THEN
            INSERT INTO public.wallet_hold(id, organization_id, ledger_entry_id, payment_attempt_id,
              amount_minor, state, reason_code)
            VALUES (gen_random_uuid()::text, attempt_row.organization_id, ledger_id, attempt_row.id,
              hold_minor, 'ACTIVE', CASE WHEN any_refund AND NOT any_lost_dispute THEN 'STRIPE_REFUND' ELSE 'STRIPE_DISPUTE' END);
          END IF;
          IF any_open_dispute AND final_attempt_state = 'DISPUTED' THEN
            -- A pending-status event can arrive before its Checkout success event.
            UPDATE public.provider_event SET state = 'PROCESSED', processed_at = now()
             WHERE payment_attempt_id = attempt_row.id AND related_payment_id = target_payment_intent_id
               AND event_type = 'charge.dispute.created' AND state = 'RECONCILIATION_REQUIRED';
          END IF;
        END IF;
        UPDATE public.provider_event e SET state = CASE
          WHEN e.event_type = 'charge.refunded'
            OR e.event_type = 'charge.dispute.closed' AND EXISTS (
              SELECT 1 FROM public.stripe_dispute_state d
               WHERE d.provider_dispute_id = e.provider_object_id AND d.payment_attempt_id = attempt_row.id AND d.state = 'LOST'
            ) THEN 'RECONCILIATION_REQUIRED'
          ELSE 'PROCESSED' END,
          processed_at = now()
         WHERE e.payment_attempt_id = attempt_row.id AND e.related_payment_id = target_payment_intent_id
           AND e.event_type IN ('charge.dispute.created', 'charge.dispute.closed', 'charge.refunded')
           AND e.provider_event_id <> target_event_id;
        INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, metadata)
        VALUES (gen_random_uuid()::text, attempt_row.organization_id, attempt_row.actor_user_id,
          'WALLET_TOPUP_SETTLED', 'PAYMENT_ATTEMPT', attempt_row.id,
          jsonb_build_object('amountMinor', attempt_row.amount_minor::text, 'currency', 'USD', 'provider', 'STRIPE'));
        IF final_attempt_state = 'DISPUTED' THEN
          INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, metadata)
          VALUES (gen_random_uuid()::text, attempt_row.organization_id, NULL, 'WALLET_TOPUP_DISPUTED',
            'PAYMENT_ATTEMPT', attempt_row.id, jsonb_build_object('heldMinor', hold_minor::text, 'source', 'OUT_OF_ORDER_PROVIDER_EVENTS'));
        ELSIF final_attempt_state = 'REVERSED' THEN
          INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, metadata)
          VALUES (gen_random_uuid()::text, attempt_row.organization_id, NULL, 'WALLET_TOPUP_REVERSAL_RECONCILIATION',
            'PAYMENT_ATTEMPT', attempt_row.id, jsonb_build_object('heldMinor', hold_minor::text,
              'reason', CASE WHEN any_refund THEN 'STRIPE_REFUND' ELSE 'STRIPE_DISPUTE' END, 'status', 'OPEN'));
        END IF;
      END IF;
    END IF;
  ELSIF target_event_type IN ('charge.dispute.created', 'charge.dispute.closed', 'charge.refunded') THEN
    SELECT * INTO attempt_row FROM public.payment_attempt
     WHERE provider_payment_id = target_payment_intent_id
        OR (target_attempt_id IS NOT NULL AND id = target_attempt_id)
     ORDER BY CASE WHEN id = target_attempt_id THEN 0 ELSE 1 END
     LIMIT 1 FOR UPDATE;
    IF NOT FOUND OR target_payment_intent_id IS NULL THEN
      result_code := 'RECONCILIATION_REQUIRED';
    ELSIF attempt_row.provider_payment_id IS NOT NULL AND attempt_row.provider_payment_id <> target_payment_intent_id THEN
      result_code := 'RECONCILIATION_REQUIRED';
    ELSE
      UPDATE public.provider_event SET payment_attempt_id = attempt_row.id
       WHERE provider = 'STRIPE' AND provider_event_id = target_event_id;
      IF attempt_row.state IN ('CREATED', 'PENDING') AND target_event_type = 'charge.refunded' THEN
        result_code := 'RECONCILIATION_REQUIRED';
      ELSIF attempt_row.state IN ('CREATED', 'PENDING') THEN
        IF target_dispute_id IS NULL OR target_dispute_id !~ '^dp_[A-Za-z0-9_]+$'
           OR target_event_type = 'charge.dispute.closed'
             AND (target_dispute_status IS NULL OR target_dispute_status NOT IN ('won', 'lost')) THEN
          result_code := 'RECONCILIATION_REQUIRED';
        ELSE
          incoming_dispute_state := CASE
            WHEN target_event_type = 'charge.dispute.created' THEN 'OPEN'
            WHEN target_dispute_status = 'won' THEN 'WON'
            ELSE 'LOST'
          END;
          SELECT state, last_event_created_at INTO dispute_state, settle_time
            FROM public.stripe_dispute_state WHERE provider_dispute_id = target_dispute_id FOR UPDATE;
          IF NOT FOUND THEN
            INSERT INTO public.stripe_dispute_state(provider_dispute_id, payment_attempt_id, state, last_event_created_at)
            VALUES (target_dispute_id, attempt_row.id, incoming_dispute_state, target_event_created_at);
          ELSIF (SELECT payment_attempt_id FROM public.stripe_dispute_state WHERE provider_dispute_id = target_dispute_id) <> attempt_row.id THEN
            result_code := 'RECONCILIATION_REQUIRED';
          ELSIF target_event_created_at > settle_time
             OR (target_event_created_at = settle_time AND dispute_state = 'OPEN' AND incoming_dispute_state <> 'OPEN') THEN
            UPDATE public.stripe_dispute_state SET state = incoming_dispute_state,
              last_event_created_at = target_event_created_at, updated_at = now()
             WHERE provider_dispute_id = target_dispute_id;
          ELSIF target_event_created_at = settle_time AND dispute_state <> incoming_dispute_state
             AND dispute_state <> 'OPEN' AND incoming_dispute_state <> 'OPEN' THEN
            result_code := 'RECONCILIATION_REQUIRED';
          END IF;
          IF result_code <> 'RECONCILIATION_REQUIRED' THEN result_code := 'RECONCILIATION_REQUIRED'; END IF;
        END IF;
      ELSIF attempt_row.state NOT IN ('SETTLED', 'DISPUTED', 'REVERSED') THEN
        result_code := 'RECONCILIATION_REQUIRED';
      ELSE
        SELECT * INTO ledger_row FROM public.wallet_ledger_entry
         WHERE organization_id = attempt_row.organization_id AND operation = 'STRIPE_TOP_UP'
           AND idempotency_key = attempt_row.id FOR SHARE;
        SELECT * INTO grant_row FROM public.access_grant WHERE ledger_entry_id = ledger_row.id FOR UPDATE;
        SELECT balance_minor INTO wallet_minor FROM public.wallet_account
         WHERE organization_id = attempt_row.organization_id FOR UPDATE;
        SELECT coalesce(sum(amount_minor), 0) INTO held_minor FROM public.wallet_hold
         WHERE organization_id = attempt_row.organization_id AND state = 'ACTIVE';
        hold_minor := greatest(wallet_minor - held_minor, 0);
        IF target_event_type = 'charge.refunded' THEN
          result_code := 'RECONCILIATION_REQUIRED';
          UPDATE public.payment_attempt SET state = 'REVERSED', updated_at = now() WHERE id = attempt_row.id;
          IF grant_row.id IS NOT NULL AND grant_row.state <> 'REVOKED' THEN
            UPDATE public.access_grant SET state = 'REVOKED', suspension_reason = 'STRIPE_REVERSAL', updated_at = now()
             WHERE id = grant_row.id;
          END IF;
          -- The existing top-up credit is immutable. Keep a linked hold on any
          -- unheld available balance for Finance/Support reconciliation; never
          -- invent a negative wallet balance or mutate the original credit.
          IF NOT EXISTS (SELECT 1 FROM public.wallet_hold WHERE payment_attempt_id = attempt_row.id AND state = 'ACTIVE')
             AND hold_minor > 0 THEN
            INSERT INTO public.wallet_hold(id, organization_id, ledger_entry_id, payment_attempt_id,
              amount_minor, state, reason_code)
            VALUES (gen_random_uuid()::text, attempt_row.organization_id, ledger_row.id, attempt_row.id,
              hold_minor, 'ACTIVE', CASE WHEN target_event_type = 'charge.refunded' THEN 'STRIPE_REFUND' ELSE 'STRIPE_DISPUTE' END);
          END IF;
          INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, metadata)
          VALUES (gen_random_uuid()::text, attempt_row.organization_id, NULL, 'WALLET_TOPUP_REVERSAL_RECONCILIATION',
            'PAYMENT_ATTEMPT', attempt_row.id, jsonb_build_object('disputeId', target_dispute_id,
              'eventType', target_event_type, 'heldMinor', hold_minor::text, 'status', 'OPEN'));

        ELSIF target_dispute_id IS NULL OR target_dispute_id !~ '^dp_[A-Za-z0-9_]+$'
           OR target_event_type = 'charge.dispute.closed'
             AND (target_dispute_status IS NULL OR target_dispute_status NOT IN ('won', 'lost')) THEN
          result_code := 'RECONCILIATION_REQUIRED';
        ELSE
          incoming_dispute_state := CASE
            WHEN target_event_type = 'charge.dispute.created' THEN 'OPEN'
            WHEN target_dispute_status = 'won' THEN 'WON'
            ELSE 'LOST'
          END;
          SELECT state, last_event_created_at INTO dispute_state, settle_time
            FROM public.stripe_dispute_state WHERE provider_dispute_id = target_dispute_id FOR UPDATE;
          IF NOT FOUND THEN
            INSERT INTO public.stripe_dispute_state(provider_dispute_id, payment_attempt_id, state, last_event_created_at)
            VALUES (target_dispute_id, attempt_row.id, incoming_dispute_state, target_event_created_at);
            dispute_state := incoming_dispute_state;
          ELSIF (SELECT payment_attempt_id FROM public.stripe_dispute_state WHERE provider_dispute_id = target_dispute_id) <> attempt_row.id THEN
            result_code := 'RECONCILIATION_REQUIRED';
          ELSE
            IF target_event_created_at < settle_time
              OR (target_event_created_at = settle_time AND dispute_state IN ('WON', 'LOST') AND incoming_dispute_state = 'OPEN') THEN
              -- Stripe may redeliver an older opened event after a terminal result.
              event_is_stale := true;
            ELSIF target_event_created_at = settle_time AND dispute_state <> incoming_dispute_state
              AND dispute_state <> 'OPEN' AND incoming_dispute_state <> 'OPEN' THEN
              result_code := 'RECONCILIATION_REQUIRED';
            ELSE
              UPDATE public.stripe_dispute_state SET state = incoming_dispute_state,
                last_event_created_at = target_event_created_at, updated_at = now()
               WHERE provider_dispute_id = target_dispute_id;
              dispute_state := incoming_dispute_state;
            END IF;
          END IF;

          IF result_code <> 'RECONCILIATION_REQUIRED' AND NOT event_is_stale THEN
            SELECT EXISTS (SELECT 1 FROM public.stripe_dispute_state WHERE payment_attempt_id = attempt_row.id AND state = 'OPEN')
              INTO any_open_dispute;
            SELECT EXISTS (SELECT 1 FROM public.stripe_dispute_state WHERE payment_attempt_id = attempt_row.id AND state = 'LOST')
              INTO any_lost_dispute;
            IF any_lost_dispute OR attempt_row.state = 'REVERSED' THEN
              result_code := 'RECONCILIATION_REQUIRED';
              UPDATE public.payment_attempt SET state = 'REVERSED', updated_at = now() WHERE id = attempt_row.id;
              IF grant_row.id IS NOT NULL AND grant_row.state <> 'REVOKED' THEN
                UPDATE public.access_grant SET state = 'REVOKED', suspension_reason = 'STRIPE_REVERSAL', updated_at = now()
                 WHERE id = grant_row.id;
              END IF;
              IF NOT EXISTS (SELECT 1 FROM public.wallet_hold WHERE payment_attempt_id = attempt_row.id AND state = 'ACTIVE')
                 AND hold_minor > 0 THEN
                INSERT INTO public.wallet_hold(id, organization_id, ledger_entry_id, payment_attempt_id,
                  amount_minor, state, reason_code)
                VALUES (gen_random_uuid()::text, attempt_row.organization_id, ledger_row.id, attempt_row.id,
                  hold_minor, 'ACTIVE', 'STRIPE_DISPUTE');
              END IF;
              INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, metadata)
              VALUES (gen_random_uuid()::text, attempt_row.organization_id, NULL, 'WALLET_TOPUP_REVERSAL_RECONCILIATION',
                'PAYMENT_ATTEMPT', attempt_row.id, jsonb_build_object('disputeId', target_dispute_id,
                  'eventType', target_event_type, 'heldMinor', hold_minor::text, 'status', 'OPEN'));
            ELSIF any_open_dispute THEN
              UPDATE public.payment_attempt SET state = 'DISPUTED', updated_at = now() WHERE id = attempt_row.id;
              IF grant_row.id IS NOT NULL AND grant_row.state = 'ACTIVE' THEN
                UPDATE public.access_grant SET state = 'SUSPENDED', suspension_reason = 'STRIPE_DISPUTE', updated_at = now()
                 WHERE id = grant_row.id;
              END IF;
              IF NOT EXISTS (SELECT 1 FROM public.wallet_hold WHERE payment_attempt_id = attempt_row.id AND state = 'ACTIVE')
                 AND hold_minor > 0 THEN
                INSERT INTO public.wallet_hold(id, organization_id, ledger_entry_id, payment_attempt_id,
                  amount_minor, state, reason_code)
                VALUES (gen_random_uuid()::text, attempt_row.organization_id, ledger_row.id, attempt_row.id,
                  hold_minor, 'ACTIVE', 'STRIPE_DISPUTE');
              END IF;
              INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, metadata)
              VALUES (gen_random_uuid()::text, attempt_row.organization_id, NULL, 'WALLET_TOPUP_DISPUTED',
                'PAYMENT_ATTEMPT', attempt_row.id, jsonb_build_object('disputeId', target_dispute_id, 'heldMinor', hold_minor::text));
            ELSE
              UPDATE public.payment_attempt SET state = 'SETTLED', updated_at = now() WHERE id = attempt_row.id;
              IF grant_row.id IS NOT NULL AND grant_row.state = 'SUSPENDED'
                 AND grant_row.suspension_reason = 'STRIPE_DISPUTE' THEN
                UPDATE public.access_grant SET state = 'ACTIVE', suspension_reason = NULL, updated_at = now()
                 WHERE id = grant_row.id;
              END IF;
              UPDATE public.wallet_hold SET state = 'RELEASED', released_at = now()
               WHERE payment_attempt_id = attempt_row.id AND state = 'ACTIVE' AND reason_code = 'STRIPE_DISPUTE';
              INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, metadata)
              VALUES (gen_random_uuid()::text, attempt_row.organization_id, NULL, 'WALLET_TOPUP_DISPUTE_WON',
                'PAYMENT_ATTEMPT', attempt_row.id, jsonb_build_object('disputeId', target_dispute_id, 'heldMinorReleased', held_minor::text));
            END IF;
          END IF;
        END IF;
      END IF;
    END IF;
  ELSE
    result_code := 'RECONCILIATION_REQUIRED';
  END IF;

  UPDATE public.provider_event SET state = result_code, processed_at = now()
   WHERE provider = 'STRIPE' AND provider_event_id = target_event_id;
  RETURN result_code;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_process_stripe_event(text, text, text, text, text, text, text, numeric, text, text, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_process_stripe_event(text, text, text, text, text, text, text, numeric, text, text, timestamptz, text, text) TO gphkm_runtime;

-- Finance queue returns reconciliation facts only, never customer content.
CREATE FUNCTION public.gphkm_list_stripe_reconciliation()
RETURNS TABLE(
  provider_event_id text,
  event_type text,
  event_state text,
  received_at timestamptz,
  payment_attempt_id text,
  organization_id text,
  attempt_state text,
  amount_minor numeric,
  currency text,
  topup_ledger_id text,
  active_hold_minor numeric,
  hold_reason text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.staff_account s
    WHERE s.user_id = nullif(current_setting('app.user_id', true), '') AND s.active
      AND s.role IN ('FINANCE', 'SUPER_ADMIN')) THEN
    RAISE EXCEPTION 'wallet reconciliation unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT e.provider_event_id, e.event_type, e.state, e.received_at,
    a.id, a.organization_id, a.state, a.amount_minor, a.currency, le.id,
    coalesce(sum(h.amount_minor) FILTER (WHERE h.state = 'ACTIVE'), 0),
    string_agg(DISTINCT h.reason_code, ', ' ORDER BY h.reason_code) FILTER (WHERE h.state = 'ACTIVE')
  FROM public.provider_event e
  LEFT JOIN public.payment_attempt a ON a.id = e.payment_attempt_id
  LEFT JOIN public.wallet_ledger_entry le ON le.organization_id = a.organization_id
    AND le.operation = 'STRIPE_TOP_UP' AND le.idempotency_key = a.id
  LEFT JOIN public.wallet_hold h ON h.payment_attempt_id = a.id
  WHERE e.provider = 'STRIPE'
    AND (e.state = 'RECONCILIATION_REQUIRED'
      OR (h.state = 'ACTIVE' AND h.reason_code = 'STRIPE_DISPUTE' AND e.event_type = 'charge.dispute.created'
        AND EXISTS (SELECT 1 FROM public.stripe_dispute_state d WHERE d.provider_dispute_id = e.provider_object_id
          AND d.payment_attempt_id = a.id AND d.state = 'OPEN')))
  GROUP BY e.provider_event_id, e.event_type, e.state, e.received_at, a.id, a.organization_id,
    a.state, a.amount_minor, a.currency, le.id
  ORDER BY e.received_at DESC
  LIMIT 200;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_list_stripe_reconciliation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_list_stripe_reconciliation() TO gphkm_runtime;
