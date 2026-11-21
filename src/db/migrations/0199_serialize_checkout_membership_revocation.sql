-- Keep an active membership from being revoked between checkout authorization
-- and the wallet debit. Membership removal takes FOR UPDATE on this same row.
CREATE OR REPLACE FUNCTION public.gphkm_finalize_order_checkout(target_order_id text) RETURNS text
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

  -- Preserve the wallet-risk serialization order used by all wallet commands.
  PERFORM pg_advisory_xact_lock(hashtextextended('gphkm:wallet-risk:' || org_id, 0));

  SELECT organization_id, actor_user_id INTO order_org_id, order_actor_id
    FROM public.customer_order WHERE id = target_order_id FOR UPDATE;
  IF NOT FOUND OR order_org_id <> org_id OR order_actor_id <> actor_id THEN
    RAISE EXCEPTION 'order unavailable' USING ERRCODE = '42501';
  END IF;

  -- Held through transaction end. This conflicts with the member-removal
  -- command's FOR UPDATE lock, so either removal commits first and checkout
  -- fails closed, or checkout commits first while membership is still active.
  PERFORM 1 FROM public.organization_member
    WHERE organization_id = org_id AND user_id = actor_id AND active
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order unavailable' USING ERRCODE = '42501';
  END IF;

  RETURN public.gphkm_finalize_order_checkout_unserialized(target_order_id);
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_finalize_order_checkout(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_finalize_order_checkout(text) TO gphkm_runtime;
