-- Return only the latest approved customer-safe value per listing/provider/scope.
-- Looking at the latest row before filtering status ensures a later MISSING,
-- FAILED, STALE, or unapproved observation hides an older public value.
CREATE FUNCTION public.gphkm_latest_customer_listing_metrics(
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
       SELECT 1 FROM public.organization o
       WHERE o.id = target_org_id AND (
         o.created_at > now() - interval '15 days'
         OR EXISTS (SELECT 1 FROM public.access_grant g WHERE g.organization_id = o.id
           AND g.state = 'ACTIVE' AND g.starts_at <= now() AND (g.ends_at IS NULL OR g.ends_at > now()))
       )
     ) THEN
    RAISE EXCEPTION 'customer metrics unavailable' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT latest.listing_id, latest.provider::text, latest.value,
    latest.observed_on, latest.source, latest.attribution_text
  FROM (
    SELECT DISTINCT ON (m.listing_id, m.provider, m.metric_scope)
      m.listing_id, m.provider, m.metric_scope, m.value, m.status,
      m.observed_on, m.source, m.attribution_text, m.redistribution_approved
    FROM public.listing_metric_observation m
    JOIN public.marketplace_listing l ON l.id = m.listing_id AND l.status = 'LIVE'
    WHERE m.listing_id = ANY(target_listing_ids)
    ORDER BY m.listing_id, m.provider, m.metric_scope, m.refreshed_at DESC, m.id DESC
  ) latest
  WHERE latest.status = 'AVAILABLE'
    AND latest.redistribution_approved
    AND latest.attribution_text IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_latest_customer_listing_metrics(text[],text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_latest_customer_listing_metrics(text[],text,text) TO gphkm_runtime;
