-- Custom SQL migration file, put your code below! --
-- Serialize assignment against staff role/deactivation transitions. Lock the
-- authority row first, matching gphkm_deactivate_staff's lock order.
CREATE OR REPLACE FUNCTION public.gphkm_assign_fulfillment_item(target_item_id text, target_admin_id text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  current_assignee text;
  item_organization_id text;
  target_role text;
  target_active boolean;
BEGIN
  IF actor_id IS NULL
     OR NOT (public.gphkm_is_active_staff(actor_id, 'ADMIN')
       OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN'))
     OR target_item_id IS NULL OR target_item_id !~ '^[0-9a-f-]{36}$'
     OR (target_admin_id IS NOT NULL AND target_admin_id !~ '^[0-9a-f-]{36}$') THEN
    RAISE EXCEPTION 'Fulfillment assignment unavailable' USING ERRCODE = '42501';
  END IF;

  IF target_admin_id IS NOT NULL THEN
    SELECT role, active INTO target_role, target_active
      FROM public.staff_account WHERE user_id = target_admin_id FOR SHARE;
    IF NOT FOUND OR target_role <> 'ADMIN' OR NOT target_active THEN
      RAISE EXCEPTION 'Choose an active Admin' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT fulfillment.assigned_admin_id, customer_order.organization_id
    INTO current_assignee, item_organization_id
    FROM public.order_item_fulfillment fulfillment
    JOIN public.customer_order ON customer_order.id = fulfillment.order_id
   WHERE fulfillment.order_item_id = target_item_id FOR UPDATE OF fulfillment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fulfillment item unavailable' USING ERRCODE = '23514';
  END IF;

  UPDATE public.order_item_fulfillment SET assigned_admin_id = target_admin_id, updated_at = now()
   WHERE order_item_id = target_item_id;
  IF current_assignee IS DISTINCT FROM target_admin_id THEN
    INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, item_organization_id, actor_id, 'FULFILLMENT_ASSIGNMENT_CHANGED',
      'CUSTOMER_ORDER_ITEM', target_item_id, 'ADMIN_ASSIGNMENT',
      jsonb_build_object('previousAssigneeId', current_assignee, 'newAssigneeId', target_admin_id));
  END IF;
  RETURN target_item_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.gphkm_deactivate_staff(target_user text, target_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); target_role text; target_active boolean; active_admins integer;
BEGIN
  IF actor_id IS NULL OR target_user IS NULL OR actor_id = target_user OR target_reason !~ '^[A-Z0-9_]{2,64}$' THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('staff-active-admins', 0));
  IF NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'staff account unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT role, active INTO target_role, target_active FROM public.staff_account WHERE user_id = target_user FOR UPDATE;
  IF NOT FOUND OR NOT target_active THEN RAISE EXCEPTION 'active staff account unavailable' USING ERRCODE = '23514'; END IF;
  IF target_role = 'SUPER_ADMIN' THEN
    SELECT count(*) INTO active_admins FROM public.staff_account WHERE role = 'SUPER_ADMIN' AND active;
    IF active_admins <= 1 THEN RAISE EXCEPTION 'cannot deactivate the last active Super Admin' USING ERRCODE = '23514'; END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.order_item_fulfillment
     WHERE assigned_admin_id = target_user AND state NOT IN ('COMPLETED', 'CANCELED_REFUNDED')
  ) THEN
    RAISE EXCEPTION 'reassign active fulfillment work before deactivating this staff member' USING ERRCODE = '23514';
  END IF;
  UPDATE public.staff_account SET active = false WHERE user_id = target_user AND active;
  DELETE FROM public.auth_session WHERE user_id = target_user;
  INSERT INTO public.audit_event(id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, actor_id, 'staff.deactivated', 'staff_account', target_user, target_reason,
      jsonb_build_object('result', 'deactivated'));
END;
$$;
