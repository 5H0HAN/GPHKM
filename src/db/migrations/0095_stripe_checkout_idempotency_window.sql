-- Stripe API v1 idempotency keys can be pruned after 24 hours. Keep a durable
-- first-dispatch timestamp and stop retrying session creation after 23 hours,
-- leaving a conservative reconciliation window before a repeated key may
-- create a new provider object.
ALTER TABLE public.payment_attempt
  ADD COLUMN checkout_session_create_started_at timestamptz;

CREATE FUNCTION public.gphkm_begin_stripe_checkout_session_create(target_attempt_id text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  org_id text := nullif(current_setting('app.organization_id', true), '');
  attempt_org_id text;
  attempt_row public.payment_attempt%ROWTYPE;
BEGIN
  SELECT organization_id INTO attempt_org_id
    FROM public.payment_attempt WHERE id = target_attempt_id;
  IF NOT FOUND OR org_id IS NULL OR attempt_org_id <> org_id THEN
    RAISE EXCEPTION 'wallet funding unavailable' USING ERRCODE = '42501';
  END IF;

  -- Match the organization-before-attempt lock order used by wallet funding
  -- and authority changes.
  PERFORM 1 FROM public.organization WHERE id = org_id AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT public.gphkm_is_active_org_owner(org_id, actor_id) THEN
    RAISE EXCEPTION 'wallet funding unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO attempt_row FROM public.payment_attempt
   WHERE id = target_attempt_id FOR UPDATE;
  IF NOT FOUND OR attempt_row.organization_id <> org_id OR attempt_row.actor_user_id <> actor_id THEN
    RAISE EXCEPTION 'wallet funding unavailable' USING ERRCODE = '42501';
  END IF;
  IF attempt_row.state NOT IN ('CREATED', 'PENDING') OR attempt_row.provider_checkout_session_id IS NOT NULL THEN
    RETURN false;
  END IF;

  IF attempt_row.checkout_session_create_started_at IS NULL THEN
    UPDATE public.payment_attempt
       SET checkout_session_create_started_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE id = attempt_row.id;
    RETURN true;
  END IF;

  RETURN attempt_row.checkout_session_create_started_at > clock_timestamp() - interval '23 hours';
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_begin_stripe_checkout_session_create(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_begin_stripe_checkout_session_create(text) TO gphkm_runtime;
