-- Bound operational profile aggregates to the documented trailing 90-day window.
ALTER FUNCTION public.gphkm_supplier_operational_summary(text, timestamptz)
  RENAME TO gphkm_supplier_operational_summary_unbounded;
REVOKE ALL ON FUNCTION public.gphkm_supplier_operational_summary_unbounded(text, timestamptz) FROM PUBLIC, gphkm_runtime;

CREATE FUNCTION public.gphkm_supplier_operational_summary(target_supplier_id text, since_at timestamptz)
RETURNS TABLE(
  paid_placements bigint,
  completed bigint,
  rejected bigint,
  canceled bigint,
  median_publication_hours double precision,
  on_time_count bigint,
  on_time_sample_size bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  bounded_since timestamptz;
BEGIN
  IF actor_id IS NULL OR NOT (
    public.gphkm_is_active_staff(actor_id, 'ADMIN')
    OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')
  ) THEN
    RAISE EXCEPTION 'supplier operational summary unavailable' USING ERRCODE = '42501';
  END IF;
  IF target_supplier_id IS NULL OR length(target_supplier_id) > 80 OR since_at IS NULL THEN
    RAISE EXCEPTION 'supplier operational summary input invalid' USING ERRCODE = '22023';
  END IF;
  bounded_since := greatest(since_at, now() - interval '90 days');
  RETURN QUERY SELECT *
    FROM public.gphkm_supplier_operational_summary_unbounded(target_supplier_id, bounded_since);
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_operational_summary(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_supplier_operational_summary(text, timestamptz) TO gphkm_runtime;
