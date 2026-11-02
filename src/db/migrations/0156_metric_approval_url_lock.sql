-- Custom SQL migration file, put your code below! --
CREATE OR REPLACE FUNCTION public.gphkm_guard_metric_approval_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  observation public.listing_metric_observation%ROWTYPE;
  current_url public.marketplace_listing_url%ROWTYPE;
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
  IF NEW.decision = 'APPROVED' THEN
    SELECT * INTO current_url FROM public.marketplace_listing_url
    WHERE listing_id = observation.listing_id FOR SHARE;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.listing_metric_observation newer
    WHERE newer.listing_id = observation.listing_id AND newer.provider = observation.provider
      AND newer.metric_scope = observation.metric_scope
      AND (newer.refreshed_at, newer.id) > (observation.refreshed_at, observation.id)
  ) THEN
    RAISE EXCEPTION 'metric observation is no longer current' USING ERRCODE = '40001';
  END IF;
  IF NEW.decision = 'APPROVED' AND (
    observation.status <> 'AVAILABLE' OR observation.value IS NULL
    OR observation.metric_target IS NULL OR observation.requested_target IS NULL
    OR NOT public.gphkm_metric_domain_refreshable(observation.requested_target)
    OR current_url.listing_id IS NULL
    OR observation.refreshed_at < current_url.updated_at
    OR observation.requested_target <> lower(rtrim(regexp_replace(current_url.website_url, '^https://', ''), '/'))
  ) THEN
    RAISE EXCEPTION 'only a current available public-target observation may be approved' USING ERRCODE = '23514';
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
