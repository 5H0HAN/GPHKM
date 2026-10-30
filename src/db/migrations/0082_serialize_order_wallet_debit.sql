-- The wallet debit command is a database-executable surface. Acquire the same
-- organization lock inside its wrapper so every invocation serializes with
-- top-ups, webhook risk events, and Finance resolution before locking rows.
ALTER FUNCTION public.gphkm_finalize_order_checkout(text)
  RENAME TO gphkm_finalize_order_checkout_unserialized;
REVOKE ALL ON FUNCTION public.gphkm_finalize_order_checkout_unserialized(text)
  FROM PUBLIC, gphkm_runtime;

CREATE FUNCTION public.gphkm_finalize_order_checkout(target_order_id text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  org_id text := nullif(current_setting('app.organization_id', true), '');
  order_org_id text;
  order_actor_id text;
BEGIN
  IF actor_id IS NULL OR org_id IS NULL OR target_order_id IS NULL THEN
    RAISE EXCEPTION 'order unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id, actor_user_id INTO order_org_id, order_actor_id
    FROM public.customer_order WHERE id = target_order_id;
  IF NOT FOUND OR order_org_id <> org_id OR order_actor_id <> actor_id
     OR NOT public.gphkm_is_active_org_member(org_id, actor_id) THEN
    RAISE EXCEPTION 'order unavailable' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('gphkm:wallet-risk:' || org_id, 0));
  RETURN public.gphkm_finalize_order_checkout_unserialized(target_order_id);
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_finalize_order_checkout(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_finalize_order_checkout(text) TO gphkm_runtime;
