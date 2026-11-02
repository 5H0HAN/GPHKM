-- The previously applied directory command used a local variable named
-- current_role, which collides with PostgreSQL's CURRENT_ROLE expression.
-- Recreate the function with an unambiguous local variable without changing
-- its authorization, lock order, transition checks, or audit behavior.
CREATE OR REPLACE FUNCTION public.gphkm_staff_update_customer_membership(
  target_organization text, target_user text, expected_role text, expected_active boolean,
  target_role text, target_active boolean, reason text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); membership_id text;
  current_member_role text; current_active boolean; other_owners integer;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'ADMIN')
     OR target_organization IS NULL OR target_user IS NULL
     OR expected_role IS NULL OR expected_role NOT IN ('OWNER', 'MEMBER')
     OR target_role IS NULL OR target_role NOT IN ('OWNER', 'MEMBER')
     OR expected_active IS NULL OR target_active IS NULL
     OR reason IS NULL OR reason NOT IN ('CUSTOMER_REQUEST', 'SUPPORT_REVIEW', 'SECURITY_REVIEW', 'CORRECTION') THEN
    RAISE EXCEPTION 'customer membership unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organization o WHERE o.id = target_organization AND o.closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer membership unavailable' USING ERRCODE = '23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-owners:' || target_organization, 0));
  SELECT m.id, m.role, m.active INTO membership_id, current_member_role, current_active
    FROM public.organization_member m JOIN public.auth_user u ON u.id = m.user_id
    WHERE m.organization_id = target_organization AND m.user_id = target_user
      AND NOT EXISTS (SELECT 1 FROM public.staff_account s WHERE s.user_id = u.id)
    FOR UPDATE OF m;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer membership unavailable' USING ERRCODE = '23514'; END IF;
  IF current_member_role <> expected_role OR current_active <> expected_active THEN
    RAISE EXCEPTION 'customer membership changed; refresh first' USING ERRCODE = '40001';
  END IF;
  IF current_member_role = target_role AND current_active = target_active THEN RETURN false; END IF;
  IF current_active AND current_member_role = 'OWNER' AND (NOT target_active OR target_role <> 'OWNER') THEN
    SELECT count(*) INTO other_owners FROM public.organization_member m
      WHERE m.organization_id = target_organization AND m.user_id <> target_user AND m.role = 'OWNER' AND m.active;
    IF other_owners = 0 THEN RAISE EXCEPTION 'the last active owner cannot be removed or demoted' USING ERRCODE = '23514'; END IF;
  END IF;
  UPDATE public.organization_member SET role = target_role, active = target_active
    WHERE id = membership_id;
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, target_organization, actor_id, 'customer.organization_membership_changed',
      'organization_member', membership_id, reason,
      jsonb_build_object('fromState', current_member_role || ':' || current_active::text,
        'toState', target_role || ':' || target_active::text));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_staff_update_customer_membership(text, text, text, boolean, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_staff_update_customer_membership(text, text, text, boolean, text, boolean, text) TO gphkm_runtime;
