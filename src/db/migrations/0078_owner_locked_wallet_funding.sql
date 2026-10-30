-- Serialize wallet-funding authorization with Owner removal and organization closure.
-- Always lock the organization before locking its payment-attempt row.

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
     OR target_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'wallet funding unavailable' USING ERRCODE = '42501';
  END IF;
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

CREATE OR REPLACE FUNCTION public.gphkm_attach_stripe_checkout_session(
  target_attempt_id text,
  target_checkout_session_id text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  org_id text := nullif(current_setting('app.organization_id', true), '');
  attempt_org_id text;
  attempt_row public.payment_attempt%ROWTYPE;
BEGIN
  SELECT organization_id INTO attempt_org_id FROM public.payment_attempt WHERE id = target_attempt_id;
  IF NOT FOUND OR org_id IS NULL OR attempt_org_id <> org_id THEN
    RAISE EXCEPTION 'wallet funding unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organization WHERE id = org_id AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT public.gphkm_is_active_org_owner(org_id, actor_id) THEN
    RAISE EXCEPTION 'wallet funding unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO attempt_row FROM public.payment_attempt WHERE id = target_attempt_id FOR UPDATE;
  IF NOT FOUND OR attempt_row.organization_id <> org_id OR attempt_row.actor_user_id <> actor_id
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

CREATE OR REPLACE FUNCTION public.gphkm_fail_stripe_topup_attempt(target_attempt_id text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  org_id text := nullif(current_setting('app.organization_id', true), '');
  attempt_org_id text;
  attempt_row public.payment_attempt%ROWTYPE;
BEGIN
  SELECT organization_id INTO attempt_org_id FROM public.payment_attempt WHERE id = target_attempt_id;
  IF NOT FOUND OR org_id IS NULL OR attempt_org_id <> org_id THEN
    RAISE EXCEPTION 'wallet funding unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organization WHERE id = org_id AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT public.gphkm_is_active_org_owner(org_id, actor_id) THEN
    RAISE EXCEPTION 'wallet funding unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO attempt_row FROM public.payment_attempt WHERE id = target_attempt_id FOR UPDATE;
  IF NOT FOUND OR attempt_row.organization_id <> org_id OR attempt_row.actor_user_id <> actor_id THEN
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
