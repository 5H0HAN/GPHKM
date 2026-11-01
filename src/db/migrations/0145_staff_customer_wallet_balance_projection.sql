-- Admin and Super Admin may see only the current shared wallet balance for
-- organizations where the customer has an active membership. No ledger,
-- holds, funding history, or payment evidence is returned.
CREATE FUNCTION public.gphkm_staff_customer_wallet_balance_projection(target_user text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); result jsonb;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'ADMIN') THEN
    RAISE EXCEPTION 'customer wallet summary unavailable' USING ERRCODE = '42501';
  END IF;
  IF target_user IS NULL OR length(target_user) > 128 THEN
    RAISE EXCEPTION 'customer wallet summary unavailable' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'organizationId', o.id,
    'organizationName', o.name,
    'balanceMinor', coalesce(wa.balance_minor, 0)::text,
    'currency', 'USD'
  ) ORDER BY o.name, o.id), '[]'::jsonb)
  INTO result
  FROM public.organization_member m
  JOIN public.organization o ON o.id = m.organization_id
  LEFT JOIN public.wallet_account wa ON wa.organization_id = o.id
  WHERE m.user_id = target_user AND m.active AND o.closed_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.staff_account s WHERE s.user_id = target_user);

  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_staff_customer_wallet_balance_projection(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_staff_customer_wallet_balance_projection(text) TO gphkm_runtime;
