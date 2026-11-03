-- Let a Super Admin take ownership of an item without widening assignment
-- targets for other staff or allowing one Super Admin to assign another.
CREATE OR REPLACE FUNCTION public.gphkm_assign_fulfillment_item(target_item_id text, target_admin_id text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  current_assignee text;
  item_organization_id text;
  actor_role text;
  actor_active boolean;
  target_role text;
  target_active boolean;
  target_found boolean;
BEGIN
  IF actor_id IS NULL OR target_item_id IS NULL OR target_item_id !~ '^[0-9a-f-]{36}$'
     OR (target_admin_id IS NOT NULL AND target_admin_id !~ '^[0-9a-f-]{36}$') THEN
    RAISE EXCEPTION 'Fulfillment assignment unavailable' USING ERRCODE = '42501';
  END IF;

  PERFORM staff.user_id
    FROM public.staff_account staff
   WHERE staff.user_id = actor_id OR (target_admin_id IS NOT NULL AND staff.user_id = target_admin_id)
   ORDER BY staff.user_id
   FOR SHARE;

  SELECT role, active INTO actor_role, actor_active
    FROM public.staff_account WHERE user_id = actor_id;
  IF NOT FOUND OR NOT actor_active OR actor_role NOT IN ('ADMIN', 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'Fulfillment assignment unavailable' USING ERRCODE = '42501';
  END IF;
  IF target_admin_id IS NOT NULL THEN
    SELECT role, active INTO target_role, target_active
      FROM public.staff_account WHERE user_id = target_admin_id;
    target_found := FOUND;
  END IF;

  SELECT fulfillment.assigned_admin_id, customer_order.organization_id
    INTO current_assignee, item_organization_id
    FROM public.order_item_fulfillment fulfillment
    JOIN public.customer_order ON customer_order.id = fulfillment.order_id
   WHERE fulfillment.order_item_id = target_item_id FOR UPDATE OF fulfillment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fulfillment item unavailable' USING ERRCODE = '23514';
  END IF;

  IF target_admin_id IS NOT NULL AND (NOT target_found OR NOT target_active OR NOT (
    target_role = 'ADMIN'
    OR (target_role = 'SUPER_ADMIN' AND (
      (actor_role = 'SUPER_ADMIN' AND target_admin_id = actor_id)
      OR target_admin_id = current_assignee
    ))
  )) THEN
    RAISE EXCEPTION 'Choose an active Admin or assign yourself' USING ERRCODE = '23514';
  END IF;

  UPDATE public.order_item_fulfillment SET assigned_admin_id = target_admin_id, updated_at = now()
   WHERE order_item_id = target_item_id;
  IF current_assignee IS DISTINCT FROM target_admin_id THEN
    INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, item_organization_id, actor_id, 'FULFILLMENT_ASSIGNMENT_CHANGED',
      'CUSTOMER_ORDER_ITEM', target_item_id,
      CASE WHEN actor_role = 'SUPER_ADMIN' AND target_admin_id = actor_id
        THEN 'SUPER_ADMIN_SELF_ASSIGNMENT' ELSE 'ADMIN_ASSIGNMENT' END,
      jsonb_build_object('previousAssigneeId', current_assignee, 'newAssigneeId', target_admin_id));
  END IF;
  RETURN target_item_id;
END;
$$;
