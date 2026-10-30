-- Finance-only visibility for open wallet top-ups without an unresolved event
-- or formal provider-risk case. This queue is read-only; it never changes state.
CREATE FUNCTION public.gphkm_list_open_stripe_attempts()
RETURNS TABLE(
  payment_attempt_id text,
  organization_id text,
  attempt_state text,
  amount_minor numeric,
  currency text,
  created_at timestamptz,
  updated_at timestamptz,
  has_provider_session boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT (
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE')
    OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
  ) THEN
    RAISE EXCEPTION 'wallet reconciliation unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT a.id, a.organization_id, a.state, a.amount_minor, a.currency,
    a.created_at, a.updated_at, a.provider_checkout_session_id IS NOT NULL
  FROM public.payment_attempt a
  WHERE a.provider = 'STRIPE' AND a.state IN ('CREATED', 'PENDING')
  ORDER BY a.created_at, a.id
  LIMIT 100;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_list_open_stripe_attempts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_list_open_stripe_attempts() TO gphkm_runtime;
