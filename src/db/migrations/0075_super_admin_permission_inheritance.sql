-- Super Admin inherits ordinary staff permissions while protected functions
-- still enforce their own evidence, ledger, and audit invariants.
CREATE OR REPLACE FUNCTION public.gphkm_is_active_staff(target_user text, required_role text DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.staff_account s
    WHERE s.user_id = target_user AND s.active
      AND (required_role IS NULL OR s.role = required_role OR s.role = 'SUPER_ADMIN'))
$$;
