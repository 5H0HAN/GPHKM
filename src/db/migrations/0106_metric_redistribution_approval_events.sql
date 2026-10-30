CREATE TABLE public.listing_metric_approval_event (
  id text PRIMARY KEY,
  event_sequence bigserial NOT NULL UNIQUE,
  observation_id text NOT NULL REFERENCES public.listing_metric_observation(id),
  listing_id text NOT NULL REFERENCES public.marketplace_listing(id),
  provider public.catalog_metric_provider NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REVOKED')),
  attribution_text text,
  evidence_reference text NOT NULL,
  reason text NOT NULL,
  actor_user_id text NOT NULL REFERENCES public.auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listing_metric_approval_attribution CHECK (
    (decision = 'APPROVED' AND attribution_text IS NOT NULL AND length(btrim(attribution_text)) BETWEEN 1 AND 300)
    OR (decision = 'REVOKED' AND attribution_text IS NULL)
  ),
  CONSTRAINT listing_metric_approval_evidence_length CHECK (length(btrim(evidence_reference)) BETWEEN 5 AND 500),
  CONSTRAINT listing_metric_approval_reason_length CHECK (length(btrim(reason)) BETWEEN 5 AND 1000)
);
CREATE INDEX listing_metric_approval_latest_idx ON public.listing_metric_approval_event(observation_id, event_sequence DESC);
ALTER TABLE public.listing_metric_approval_event ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.listing_metric_approval_event TO gphkm_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON public.listing_metric_approval_event FROM gphkm_runtime;

CREATE POLICY listing_metric_approval_staff_read ON public.listing_metric_approval_event
  FOR SELECT TO gphkm_runtime USING (
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
  );
CREATE POLICY listing_metric_approval_staff_insert ON public.listing_metric_approval_event
  FOR INSERT TO gphkm_runtime WITH CHECK (
    actor_user_id = nullif(current_setting('app.user_id', true), '')
    AND public.gphkm_is_active_staff(actor_user_id, 'SUPER_ADMIN')
  );

CREATE FUNCTION public.gphkm_guard_metric_approval_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  observation public.listing_metric_observation%ROWTYPE;
  audit_action text;
BEGIN
  IF NEW.actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')
     OR NOT public.gphkm_is_active_staff(NEW.actor_user_id, 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'metric redistribution approval requires Super Admin' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO observation FROM public.listing_metric_observation WHERE id = NEW.observation_id;
  IF NOT FOUND OR observation.listing_id <> NEW.listing_id OR observation.provider <> NEW.provider THEN
    RAISE EXCEPTION 'metric observation mismatch' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.listing_metric_observation newer
    WHERE newer.listing_id = observation.listing_id AND newer.provider = observation.provider
      AND newer.metric_scope = observation.metric_scope
      AND (newer.refreshed_at, newer.id) > (observation.refreshed_at, observation.id)
  ) THEN
    RAISE EXCEPTION 'metric observation is no longer current' USING ERRCODE = '40001';
  END IF;
  IF NEW.decision = 'APPROVED' AND (observation.status <> 'AVAILABLE' OR observation.value IS NULL) THEN
    RAISE EXCEPTION 'only an available observation may be approved' USING ERRCODE = '23514';
  END IF;
  audit_action := CASE NEW.decision WHEN 'APPROVED' THEN 'METRIC_REDISTRIBUTION_APPROVED' ELSE 'METRIC_REDISTRIBUTION_REVOKED' END;
  IF NOT EXISTS (
    SELECT 1 FROM public.audit_event a
    WHERE a.actor_user_id = NEW.actor_user_id AND a.action = audit_action
      AND a.target_type = 'listing_metric_observation' AND a.target_id = NEW.observation_id
      AND a.correlation_id = NEW.id
      AND a.metadata->>'listingId' = NEW.listing_id
      AND a.metadata->>'provider' = NEW.provider::text
      AND a.metadata->>'decision' = NEW.decision
  ) THEN
    RAISE EXCEPTION 'metric approval requires its matching audit event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_guard_metric_approval_event() FROM PUBLIC;
CREATE TRIGGER listing_metric_approval_guard BEFORE INSERT ON public.listing_metric_approval_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_guard_metric_approval_event();
CREATE TRIGGER listing_metric_approval_immutable BEFORE UPDATE OR DELETE ON public.listing_metric_approval_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_immutable_mutation();

CREATE FUNCTION public.gphkm_metric_observation_customer_approved(target_observation_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(current_setting('app.metric_customer_display_l05_verified', true) = 'true', false)
    AND EXISTS (
      SELECT 1 FROM public.listing_metric_observation current_metric
      JOIN LATERAL (
        SELECT e.decision FROM public.listing_metric_approval_event e
        WHERE e.observation_id = current_metric.id
        ORDER BY e.event_sequence DESC LIMIT 1
      ) decision ON true
      WHERE current_metric.id = target_observation_id
        AND current_metric.status = 'AVAILABLE' AND current_metric.value IS NOT NULL
        AND decision.decision = 'APPROVED'
        AND NOT EXISTS (
          SELECT 1 FROM public.listing_metric_observation newer
          WHERE newer.listing_id = current_metric.listing_id AND newer.provider = current_metric.provider
            AND newer.metric_scope = current_metric.metric_scope
            AND (newer.refreshed_at, newer.id) > (current_metric.refreshed_at, current_metric.id)
        )
    )
$$;
REVOKE ALL ON FUNCTION public.gphkm_metric_observation_customer_approved(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_metric_observation_customer_approved(text) TO gphkm_runtime;

DROP POLICY listing_metric_customer_read ON public.listing_metric_observation;
CREATE POLICY listing_metric_customer_read ON public.listing_metric_observation FOR SELECT TO gphkm_runtime USING (
  public.gphkm_metric_observation_customer_approved(id)
  AND EXISTS (SELECT 1 FROM public.marketplace_listing l WHERE l.id = listing_metric_observation.listing_id AND l.status = 'LIVE')
  AND EXISTS (SELECT 1 FROM public.organization o
    WHERE o.id = nullif(current_setting('app.organization_id', true), '')
      AND public.gphkm_is_active_org_member(o.id, nullif(current_setting('app.user_id', true), ''))
      AND (o.created_at > now() - interval '15 days'
        OR EXISTS (SELECT 1 FROM public.access_grant g WHERE g.organization_id = o.id AND g.state = 'ACTIVE'
          AND g.starts_at <= now() AND (g.ends_at IS NULL OR g.ends_at > now()))))
);

CREATE OR REPLACE FUNCTION public.gphkm_latest_customer_listing_metrics(
  target_listing_ids text[], target_user_id text, target_org_id text
) RETURNS TABLE(
  listing_id text, provider text, value numeric, observed_on timestamptz,
  source text, attribution_text text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF target_listing_ids IS NULL OR cardinality(target_listing_ids) > 100
     OR target_user_id IS NULL OR target_user_id <> nullif(current_setting('app.user_id', true), '')
     OR target_org_id IS NULL OR target_org_id <> nullif(current_setting('app.organization_id', true), '')
     OR NOT public.gphkm_is_active_org_member(target_org_id, target_user_id)
     OR NOT EXISTS (
       SELECT 1 FROM public.organization o WHERE o.id = target_org_id AND (
         o.created_at > now() - interval '15 days'
         OR EXISTS (SELECT 1 FROM public.access_grant g WHERE g.organization_id = o.id
           AND g.state = 'ACTIVE' AND g.starts_at <= now() AND (g.ends_at IS NULL OR g.ends_at > now()))
       )
     ) THEN
    RAISE EXCEPTION 'customer metrics unavailable' USING ERRCODE = '42501';
  END IF;
  IF NOT coalesce(current_setting('app.metric_customer_display_l05_verified', true) = 'true', false) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT latest.listing_id, latest.provider::text, latest.value, latest.observed_on,
    latest.source, approval.attribution_text
  FROM (
    SELECT DISTINCT ON (m.listing_id, m.provider, m.metric_scope)
      m.id, m.listing_id, m.provider, m.metric_scope, m.value, m.status, m.observed_on, m.source
    FROM public.listing_metric_observation m
    JOIN public.marketplace_listing l ON l.id = m.listing_id AND l.status = 'LIVE'
    WHERE m.listing_id = ANY(target_listing_ids)
    ORDER BY m.listing_id, m.provider, m.metric_scope, m.refreshed_at DESC, m.id DESC
  ) latest
  JOIN LATERAL (
    SELECT e.decision, e.attribution_text FROM public.listing_metric_approval_event e
    WHERE e.observation_id = latest.id ORDER BY e.event_sequence DESC LIMIT 1
  ) approval ON true
  WHERE latest.status = 'AVAILABLE' AND latest.value IS NOT NULL AND approval.decision = 'APPROVED';
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_latest_customer_listing_metrics(text[],text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_latest_customer_listing_metrics(text[],text,text) TO gphkm_runtime;
