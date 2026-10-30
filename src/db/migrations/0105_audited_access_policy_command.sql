REVOKE UPDATE ON public.access_policy FROM gphkm_runtime;--> statement-breakpoint

CREATE FUNCTION public.gphkm_update_access_policy(
  target_minimum_minor numeric,
  target_duration text,
  expected_version integer,
  change_reason text
) RETURNS TABLE(minimum_minor numeric, duration text, version integer, changed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor text := nullif(current_setting('app.user_id', true), '');
  prior public.access_policy%ROWTYPE;
BEGIN
  IF actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.staff_account staff
     WHERE staff.user_id = actor AND staff.active AND staff.role = 'SUPER_ADMIN'
  ) THEN
    RAISE EXCEPTION 'active Super Admin required' USING ERRCODE = '42501';
  END IF;
  IF target_minimum_minor IS NULL OR target_minimum_minor <= 0
     OR target_minimum_minor <> trunc(target_minimum_minor)
     OR target_duration NOT IN ('SIX_MONTHS', 'ONE_YEAR', 'UNRESTRICTED')
     OR expected_version IS NULL OR expected_version < 1
     OR change_reason IS NULL OR length(btrim(change_reason)) NOT BETWEEN 10 AND 500
     OR change_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid access policy change' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO prior FROM public.access_policy WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'access policy unavailable' USING ERRCODE = 'P0002'; END IF;
  IF prior.version <> expected_version THEN
    RAISE EXCEPTION 'access policy version changed' USING ERRCODE = '40001';
  END IF;
  IF prior.minimum_minor = target_minimum_minor AND prior.duration = target_duration THEN
    RETURN QUERY SELECT prior.minimum_minor, prior.duration, prior.version, false;
    RETURN;
  END IF;

  UPDATE public.access_policy
     SET minimum_minor = target_minimum_minor,
         duration = target_duration,
         version = prior.version + 1,
         updated_by = actor,
         updated_at = now()
   WHERE id = 1;

  INSERT INTO public.audit_event (
    id, organization_id, actor_user_id, action, target_type, target_id,
    reason_code, metadata, created_at
  ) VALUES (
    gen_random_uuid()::text, NULL, actor, 'ACCESS_POLICY_UPDATED', 'ACCESS_POLICY', '1',
    'POLICY_CHANGED', jsonb_build_object(
      'fromState', prior.duration,
      'toState', target_duration,
      'policyVersion', prior.version + 1,
      'minimumMinorFrom', prior.minimum_minor::text,
      'minimumMinorTo', target_minimum_minor::text,
      'reason', btrim(change_reason)
    ), now()
  );
  RETURN QUERY SELECT target_minimum_minor, target_duration, prior.version + 1, true;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.gphkm_update_access_policy(numeric, text, integer, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_update_access_policy(numeric, text, integer, text) TO gphkm_runtime;
