-- Custom SQL migration file, put your code below! --
-- Serialize Finance's evidence-based Checkout Session absence resolution with
-- Stripe webhooks, top-ups, wallet debits, and other Finance risk decisions.
-- The existing command keeps its organization-before-attempt row lock order;
-- this wrapper acquires the shared organization lock before calling it.
ALTER FUNCTION public.gphkm_resolve_missing_stripe_checkout_session(text, text, text)
  RENAME TO gphkm_resolve_missing_stripe_checkout_session_unserialized;
REVOKE ALL ON FUNCTION public.gphkm_resolve_missing_stripe_checkout_session_unserialized(text, text, text)
  FROM PUBLIC, gphkm_runtime;

CREATE FUNCTION public.gphkm_resolve_missing_stripe_checkout_session(
  target_attempt_id text, target_evidence_reference text, target_reason text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  attempt_org_id text;
BEGIN
  IF actor_id IS NULL
     OR NOT (public.gphkm_is_active_staff(actor_id, 'FINANCE')
          OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN'))
     OR target_attempt_id IS NULL OR target_attempt_id !~ '^[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'wallet reconciliation unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO attempt_org_id FROM public.payment_attempt
   WHERE id = target_attempt_id AND provider = 'STRIPE';
  IF attempt_org_id IS NULL THEN
    RAISE EXCEPTION 'checkout attempt unavailable' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('gphkm:wallet-risk:' || attempt_org_id, 0));
  RETURN public.gphkm_resolve_missing_stripe_checkout_session_unserialized(
    target_attempt_id, target_evidence_reference, target_reason);
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_resolve_missing_stripe_checkout_session(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_resolve_missing_stripe_checkout_session(text, text, text) TO gphkm_runtime;
