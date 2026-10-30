ALTER TABLE "provider_event" ADD COLUMN "provider_amount_minor" numeric(20, 0);--> statement-breakpoint
ALTER TABLE "provider_event" ADD COLUMN "provider_currency" text;--> statement-breakpoint
ALTER TABLE "provider_event" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "provider_event" ADD CONSTRAINT "provider_event_amount_valid" CHECK ("provider_event"."provider_amount_minor" is null or "provider_event"."provider_amount_minor" >= 0);--> statement-breakpoint
ALTER TABLE "provider_event" ADD CONSTRAINT "provider_event_currency_valid" CHECK ("provider_event"."provider_currency" is null or "provider_event"."provider_currency" ~ '^[a-z]{3}$');--> statement-breakpoint
ALTER TABLE "provider_event" ADD CONSTRAINT "provider_event_status_valid" CHECK ("provider_event"."provider_status" is null or length("provider_event"."provider_status") between 1 and 64);
--> statement-breakpoint
CREATE FUNCTION public.gphkm_attach_stripe_event_facts(target_event_id text, target_payload_hash text,
  target_amount_minor numeric, target_currency text, target_status text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE event_row public.provider_event%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.stripe_webhook_verified', true), '') <> 'true'
     OR target_event_id IS NULL OR target_event_id !~ '^evt_[A-Za-z0-9_]+$'
     OR target_payload_hash IS NULL OR target_payload_hash !~ '^[0-9a-f]{64}$'
     OR target_amount_minor IS NOT NULL AND (target_amount_minor < 0 OR target_amount_minor <> trunc(target_amount_minor) OR target_amount_minor > 9007199254740991)
     OR target_currency IS NOT NULL AND lower(target_currency) !~ '^[a-z]{3}$'
     OR target_status IS NOT NULL AND (length(target_status) < 1 OR length(target_status) > 64 OR target_status ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'Stripe event facts unavailable' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO event_row FROM public.provider_event
   WHERE provider = 'STRIPE' AND provider_event_id = target_event_id FOR UPDATE;
  IF NOT FOUND OR event_row.payload_hash <> target_payload_hash THEN RETURN false; END IF;
  IF (event_row.provider_amount_minor IS NOT NULL AND event_row.provider_amount_minor IS DISTINCT FROM target_amount_minor)
     OR (event_row.provider_currency IS NOT NULL AND event_row.provider_currency IS DISTINCT FROM lower(target_currency))
     OR (event_row.provider_status IS NOT NULL AND event_row.provider_status IS DISTINCT FROM target_status) THEN
    RAISE EXCEPTION 'Stripe event facts conflict' USING ERRCODE = '23505';
  END IF;
  UPDATE public.provider_event SET provider_amount_minor = target_amount_minor,
    provider_currency = lower(target_currency), provider_status = target_status
   WHERE id = event_row.id;
  RETURN true;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_attach_stripe_event_facts(text,text,numeric,text,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_attach_stripe_event_facts(text,text,numeric,text,text) TO gphkm_runtime;--> statement-breakpoint
CREATE FUNCTION public.gphkm_list_stripe_reconciliation_with_facts()
RETURNS TABLE(
  provider_event_id text, event_type text, event_state text, received_at timestamptz,
  payment_attempt_id text, organization_id text, attempt_state text,
  topup_amount_minor numeric, topup_currency text,
  provider_amount_minor numeric, provider_currency text, provider_status text,
  topup_ledger_id text, active_hold_minor numeric, hold_reason text
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
    a.id, a.organization_id, a.state, a.amount_minor, a.currency,
    e.provider_amount_minor, e.provider_currency, e.provider_status,
    le.id, coalesce(sum(h.amount_minor) FILTER (WHERE h.state = 'ACTIVE'), 0),
    string_agg(DISTINCT h.reason_code, ', ' ORDER BY h.reason_code) FILTER (WHERE h.state = 'ACTIVE')
  FROM public.provider_event e
  LEFT JOIN public.payment_attempt a ON a.id = e.payment_attempt_id
  LEFT JOIN public.wallet_ledger_entry le ON le.organization_id = a.organization_id
    AND le.operation = 'STRIPE_TOP_UP' AND le.idempotency_key = a.id
  LEFT JOIN public.wallet_hold h ON h.payment_attempt_id = a.id
  WHERE e.provider = 'STRIPE'
    AND (e.state = 'RECONCILIATION_REQUIRED'
      OR (h.state = 'ACTIVE' AND h.reason_code IN ('STRIPE_DISPUTE','STRIPE_REFUND')
        AND e.event_type IN ('charge.dispute.created','charge.refunded')))
  GROUP BY e.provider_event_id, e.event_type, e.state, e.received_at, a.id, a.organization_id,
    a.state, a.amount_minor, a.currency, e.provider_amount_minor, e.provider_currency,
    e.provider_status, le.id
  ORDER BY e.received_at DESC
  LIMIT 200;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_list_stripe_reconciliation_with_facts() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_list_stripe_reconciliation_with_facts() TO gphkm_runtime;
