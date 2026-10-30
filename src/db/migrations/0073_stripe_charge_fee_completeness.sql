-- A Finance snapshot cannot be complete without the captured charge's
-- processor balance transaction. This is enforced below the application role.
CREATE OR REPLACE FUNCTION public.gphkm_validate_stripe_finance_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  received numeric;
  charge_facts jsonb;
BEGIN
  IF NEW.complete AND (
    NEW.facts->>'detailComplete' IS DISTINCT FROM 'true'
    OR NEW.facts->>'snapshotTruncated' IS DISTINCT FROM 'false'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.facts->'refunds') r
      WHERE r->>'status' = 'succeeded'
        AND (r->'balanceTransaction' IS NULL OR r->'balanceTransaction' = 'null'::jsonb))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.facts->'disputes') d
      WHERE d->>'status' = 'lost'
        AND jsonb_array_length(d->'balanceTransactions') = 0)
  ) THEN
    NEW.complete := false;
  END IF;

  IF NEW.complete THEN
    IF coalesce(NEW.facts->>'amountReceivedMinor', '') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'Complete Stripe snapshot has invalid captured amount' USING ERRCODE = '23514';
    END IF;
    received := (NEW.facts->>'amountReceivedMinor')::numeric;
    IF received > 0 THEN
      charge_facts := NEW.facts->'chargeBalanceTransaction';
      IF jsonb_typeof(NEW.facts->'chargeId') IS DISTINCT FROM 'string'
        OR length(NEW.facts->>'chargeId') < 3
        OR jsonb_typeof(charge_facts) IS DISTINCT FROM 'object'
        OR jsonb_typeof(charge_facts->'amountMinor') IS DISTINCT FROM 'string'
        OR jsonb_typeof(charge_facts->'feeMinor') IS DISTINCT FROM 'string'
        OR jsonb_typeof(charge_facts->'netMinor') IS DISTINCT FROM 'string'
        OR jsonb_typeof(charge_facts->'currency') IS DISTINCT FROM 'string'
        OR coalesce(charge_facts->>'amountMinor', '') !~ '^[0-9]+$'
        OR coalesce(charge_facts->>'feeMinor', '') !~ '^[0-9]+$'
        OR coalesce(charge_facts->>'netMinor', '') !~ '^-?[0-9]+$'
        OR lower(charge_facts->>'currency') IS DISTINCT FROM lower(NEW.facts->>'currency') THEN
        RAISE EXCEPTION 'Complete Stripe snapshot lacks valid charge balance transaction facts' USING ERRCODE = '23514';
      END IF;
      IF (charge_facts->>'amountMinor')::numeric <> received
        OR (charge_facts->>'netMinor')::numeric <>
          (charge_facts->>'amountMinor')::numeric - (charge_facts->>'feeMinor')::numeric THEN
        RAISE EXCEPTION 'Charge balance transaction does not reconcile to captured amount and fee' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
