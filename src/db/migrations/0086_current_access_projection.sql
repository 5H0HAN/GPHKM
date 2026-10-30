-- Do not let a Member probe historical or future grant intervals through a
-- caller-selected timestamp. The customer projection answers only now.
DROP FUNCTION public.gphkm_customer_has_marketplace_access(text, timestamp without time zone);

CREATE FUNCTION public.gphkm_customer_has_marketplace_access(target_org text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  current_utc timestamp without time zone := statement_timestamp() AT TIME ZONE 'UTC';
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
       AND grant_row.starts_at <= current_utc
       AND (grant_row.ends_at IS NULL OR current_utc < grant_row.ends_at)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_customer_has_marketplace_access(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_customer_has_marketplace_access(text) TO gphkm_runtime;
