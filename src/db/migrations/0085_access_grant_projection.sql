-- Grant intervals are wallet-history data. Members only need the current
-- access decision for catalog and checkout authorization.
DROP POLICY access_grant_tenant_read ON public.access_grant;
CREATE POLICY access_grant_tenant_read ON public.access_grant FOR SELECT TO gphkm_runtime
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')
    AND public.gphkm_is_active_org_owner(organization_id, nullif(current_setting('app.user_id', true), '')));

CREATE FUNCTION public.gphkm_customer_has_marketplace_access(target_org text, at_time timestamp without time zone)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF actor_id IS NULL OR target_org IS NULL
     OR target_org <> nullif(current_setting('app.organization_id', true), '')
     OR NOT public.gphkm_is_active_org_member(target_org, actor_id) THEN
    RAISE EXCEPTION 'marketplace access unavailable' USING ERRCODE = '42501';
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.access_grant grant_row
     WHERE grant_row.organization_id = target_org
       AND grant_row.state = 'ACTIVE'
       AND grant_row.starts_at <= at_time
       AND (grant_row.ends_at IS NULL OR at_time < grant_row.ends_at)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_customer_has_marketplace_access(text, timestamp without time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_customer_has_marketplace_access(text, timestamp without time zone) TO gphkm_runtime;
