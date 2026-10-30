CREATE TABLE public.stripe_finance_snapshot (
  id text PRIMARY KEY,
  payment_attempt_id text NOT NULL REFERENCES public.payment_attempt(id),
  actor_user_id text NOT NULL REFERENCES public.auth_user(id),
  facts jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  complete boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stripe_finance_snapshot_size_valid CHECK (octet_length(facts::text) <= 200000),
  CONSTRAINT stripe_finance_snapshot_shape_valid CHECK (
    jsonb_typeof(facts) = 'object'
    AND jsonb_typeof(facts->'refunds') IS NOT DISTINCT FROM 'array'
    AND jsonb_typeof(facts->'disputes') IS NOT DISTINCT FROM 'array'
    AND jsonb_typeof(facts->'paginationComplete') IS NOT DISTINCT FROM 'boolean'
  )
);
ALTER TABLE public.stripe_finance_snapshot ENABLE ROW LEVEL SECURITY;
CREATE INDEX stripe_finance_snapshot_attempt_created_idx
  ON public.stripe_finance_snapshot(payment_attempt_id, created_at DESC);
REVOKE ALL ON public.stripe_finance_snapshot FROM PUBLIC, gphkm_runtime;
CREATE TRIGGER stripe_finance_snapshot_immutable
  BEFORE UPDATE OR DELETE ON public.stripe_finance_snapshot
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_finance_reconciliation_mutation();

CREATE FUNCTION public.gphkm_get_stripe_review_attempt(target_attempt_id text)
RETURNS TABLE(payment_attempt_id text, provider_payment_id text, amount_minor numeric, currency text, state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'FINANCE')
     OR target_attempt_id IS NULL OR target_attempt_id !~ '^[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'Stripe provider review unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT a.id, a.provider_payment_id, a.amount_minor, a.currency, a.state
    FROM public.payment_attempt a
    WHERE a.id = target_attempt_id AND a.provider = 'STRIPE' AND a.provider_payment_id IS NOT NULL
      AND (a.state IN ('DISPUTED','REVERSED') OR EXISTS (
        SELECT 1 FROM public.provider_event e WHERE e.payment_attempt_id = a.id
          AND (e.state = 'RECONCILIATION_REQUIRED' OR e.event_type = 'charge.refunded')));
END;
$$;

CREATE FUNCTION public.gphkm_store_stripe_finance_snapshot(
  target_attempt_id text, target_payload_hash text, target_complete boolean, target_facts jsonb
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  attempt_row public.payment_attempt%ROWTYPE;
  inserted_id text := gen_random_uuid()::text;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'FINANCE')
     OR target_attempt_id IS NULL OR target_attempt_id !~ '^[0-9a-f-]{36}$'
     OR target_payload_hash IS NULL OR target_payload_hash !~ '^[0-9a-f]{64}$'
     OR target_complete IS NULL OR target_facts IS NULL OR jsonb_typeof(target_facts) <> 'object'
     OR octet_length(target_facts::text) > 200000
     OR jsonb_typeof(target_facts->'refunds') IS DISTINCT FROM 'array'
     OR jsonb_typeof(target_facts->'disputes') IS DISTINCT FROM 'array'
     OR jsonb_typeof(target_facts->'paginationComplete') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'Stripe provider facts invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO attempt_row FROM public.payment_attempt a
    WHERE a.id = target_attempt_id AND a.provider = 'STRIPE' FOR SHARE;
  IF NOT FOUND OR attempt_row.provider_payment_id IS NULL
     OR target_facts->>'providerPaymentId' IS DISTINCT FROM attempt_row.provider_payment_id
     OR target_facts->>'amountMinor' IS DISTINCT FROM attempt_row.amount_minor::text
     OR lower(target_facts->>'currency') IS DISTINCT FROM lower(attempt_row.currency) THEN
    RAISE EXCEPTION 'Stripe facts do not match the funding attempt' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.stripe_finance_snapshot(id, payment_attempt_id, actor_user_id, facts, payload_hash, complete)
  VALUES (inserted_id, target_attempt_id, actor_id, target_facts, target_payload_hash,
    target_complete AND (target_facts->>'paginationComplete')::boolean);
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
  VALUES (gen_random_uuid()::text, attempt_row.organization_id, actor_id, 'STRIPE_PROVIDER_FACTS_REFRESHED',
    'PAYMENT_ATTEMPT', target_attempt_id, CASE WHEN target_complete THEN 'CURRENT_PROVIDER_FACTS_COMPLETE' ELSE 'CURRENT_PROVIDER_FACTS_INCOMPLETE' END,
    jsonb_build_object('snapshotId', inserted_id, 'payloadHash', target_payload_hash,
      'refundCount', jsonb_array_length(target_facts->'refunds'),
      'disputeCount', jsonb_array_length(target_facts->'disputes')));
  RETURN inserted_id;
END;
$$;

CREATE FUNCTION public.gphkm_list_stripe_finance_snapshots()
RETURNS TABLE(payment_attempt_id text, organization_id text, attempt_state text,
  snapshot_id text, snapshot_created_at timestamptz, snapshot_complete boolean, facts jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') THEN
    RAISE EXCEPTION 'Stripe provider review unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT a.id, a.organization_id, a.state, s.id, s.created_at, s.complete, s.facts
  FROM public.payment_attempt a
  JOIN LATERAL (SELECT x.id, x.created_at, x.complete, x.facts
    FROM public.stripe_finance_snapshot x WHERE x.payment_attempt_id = a.id
    ORDER BY x.created_at DESC, x.id DESC LIMIT 1) s ON true
  WHERE EXISTS (SELECT 1 FROM public.provider_event e WHERE e.payment_attempt_id = a.id
      AND (e.state = 'RECONCILIATION_REQUIRED' OR e.event_type = 'charge.refunded'))
     OR a.state IN ('DISPUTED','REVERSED')
  ORDER BY s.created_at DESC LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION public.gphkm_get_stripe_review_attempt(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gphkm_store_stripe_finance_snapshot(text,text,boolean,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gphkm_list_stripe_finance_snapshots() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_get_stripe_review_attempt(text) TO gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_store_stripe_finance_snapshot(text,text,boolean,jsonb) TO gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_list_stripe_finance_snapshots() TO gphkm_runtime;
