CREATE OR REPLACE FUNCTION public.gphkm_validate_snapshot_refresh_token() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  refresh_row public.stripe_finance_refresh%ROWTYPE;
  refreshed_at timestamptz;
BEGIN
  SELECT * INTO refresh_row FROM public.stripe_finance_refresh
   WHERE id = NEW.facts->>'refreshId' AND payment_attempt_id = NEW.payment_attempt_id
     AND actor_user_id = NEW.actor_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stripe snapshot refresh evidence is unavailable' USING ERRCODE = '23514'; END IF;
  refreshed_at := (NEW.facts->>'refreshedAt')::timestamptz;
  IF refreshed_at < refresh_row.started_at OR refreshed_at > clock_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION 'Stripe snapshot time does not match its refresh window' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stripe_finance_refresh newer
    WHERE newer.payment_attempt_id = NEW.payment_attempt_id
      AND (newer.started_at, newer.id) > (refresh_row.started_at, refresh_row.id)) THEN
    RAISE EXCEPTION 'A newer Stripe refresh has already started' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.gphkm_require_latest_stripe_refresh_for_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  attempt_id text;
  snapshot_refresh_id text;
  latest_refresh_id text;
BEGIN
  SELECT c.payment_attempt_id, s.facts->>'refreshId' INTO attempt_id, snapshot_refresh_id
    FROM public.stripe_reconciliation_case c
    JOIN public.stripe_finance_snapshot s ON s.id = NEW.snapshot_id
   WHERE c.id = NEW.case_id;
  SELECT id INTO latest_refresh_id FROM public.stripe_finance_refresh
   WHERE payment_attempt_id = attempt_id ORDER BY started_at DESC, id DESC LIMIT 1;
  IF attempt_id IS NULL OR snapshot_refresh_id IS DISTINCT FROM latest_refresh_id THEN
    RAISE EXCEPTION 'Use the latest Stripe provider refresh for resolution' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_require_latest_stripe_refresh_for_decision() FROM PUBLIC;
CREATE TRIGGER stripe_reconciliation_decision_require_latest_refresh
  BEFORE INSERT ON public.stripe_reconciliation_decision
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_require_latest_stripe_refresh_for_decision();

CREATE OR REPLACE FUNCTION public.gphkm_list_open_stripe_reconciliation_snapshots()
RETURNS TABLE(payment_attempt_id text, organization_id text, attempt_state text, case_id text,
  snapshot_id text, snapshot_created_at timestamptz, snapshot_complete boolean, facts jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') THEN
    RAISE EXCEPTION 'Stripe provider review unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT a.id, a.organization_id, a.state, c.id, s.id, s.created_at, s.complete, s.facts
  FROM public.stripe_reconciliation_case c
  JOIN public.payment_attempt a ON a.id = c.payment_attempt_id
  LEFT JOIN LATERAL (
    SELECT x.id, x.created_at, x.complete, x.facts FROM public.stripe_finance_snapshot x
    WHERE x.payment_attempt_id = a.id
      AND x.facts->>'refreshId' = (
        SELECT r.id FROM public.stripe_finance_refresh r WHERE r.payment_attempt_id = a.id
        ORDER BY r.started_at DESC, r.id DESC LIMIT 1
      )
    ORDER BY x.created_at DESC, x.id DESC LIMIT 1
  ) s ON true
  WHERE c.state = 'OPEN' ORDER BY c.opened_at LIMIT 100;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_list_open_stripe_reconciliation_snapshots() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_list_open_stripe_reconciliation_snapshots() TO gphkm_runtime;
