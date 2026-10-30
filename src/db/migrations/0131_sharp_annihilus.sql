ALTER TABLE "listing_metric_observation" DROP CONSTRAINT "listing_metric_observation_metric_scope_check";--> statement-breakpoint
ALTER TABLE "listing_metric_observation" ADD CONSTRAINT "listing_metric_scope_valid" CHECK ("listing_metric_observation"."metric_scope" in ('REGISTERED_DOMAIN', 'DOMAIN', 'HOST'));
--> statement-breakpoint
DROP FUNCTION public.gphkm_latest_customer_listing_metrics(text[],text,text);--> statement-breakpoint
CREATE FUNCTION public.gphkm_latest_customer_listing_metrics(
  target_listing_ids text[], target_user_id text, target_org_id text
) RETURNS TABLE(
  listing_id text, provider text, metric_scope text, value numeric, observed_on timestamptz,
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
         OR EXISTS (SELECT 1 FROM public.access_grant g WHERE g.organization_id = o.id AND g.state = 'ACTIVE'
           AND g.starts_at <= now() AND (g.ends_at IS NULL OR g.ends_at > now()))
       )
     ) THEN
    RAISE EXCEPTION 'customer metrics unavailable' USING ERRCODE = '42501';
  END IF;
  IF NOT coalesce(current_setting('app.metric_customer_display_l05_verified', true) = 'true', false) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT latest.listing_id, latest.provider::text, latest.metric_scope, latest.value,
    latest.observed_on, latest.source, approval.attribution_text
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
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_latest_customer_listing_metrics(text[],text,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_latest_customer_listing_metrics(text[],text,text) TO gphkm_runtime;
