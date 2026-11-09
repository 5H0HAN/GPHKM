-- Expose only the dispatch recipient and item reference to the current item
-- assignee. Historical packets remain subject to their original packet RLS.
CREATE FUNCTION public.gphkm_supplier_notice_dispatch(target_case text, target_item text)
RETURNS TABLE (packet_id text, recipient text, item_reference text, organization_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
BEGIN
  IF NOT (public.gphkm_is_active_staff(actor_id, 'ADMIN') OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')) THEN
    RETURN;
  END IF;

  -- Check assignment in the lock query so unauthorized callers cannot lock
  -- another staff member's fulfillment. Reassignment uses the same item lock.
  SELECT f.* INTO fulfillment_row FROM public.order_item_fulfillment f
  WHERE f.order_item_id = target_item AND f.handed_off_at IS NOT NULL
    AND f.assigned_admin_id IS NOT NULL
    AND (f.assigned_admin_id = actor_id OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN'))
    AND f.state <> 'COMPLETED'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT p.id, p.recipient, packet_item.value->>'reference', p.organization_id
  FROM public.support_case c
  JOIN public.customer_order_item i ON i.order_id = c.order_id AND i.id = target_item
  JOIN public.order_item_fulfillment_supplier route ON route.order_item_id = i.id
  JOIN public.supplier_packet_item pi ON pi.order_item_id = i.id AND pi.route_generation = route.route_generation
  JOIN public.supplier_packet p ON p.id = pi.packet_id AND p.order_id = c.order_id
    AND p.organization_id = c.organization_id AND p.supplier_id = route.supplier_id
  CROSS JOIN LATERAL jsonb_array_elements(p.packet->'items') AS packet_item(value)
  WHERE c.id = target_case AND c.merged_into_case_id IS NULL AND c.state NOT IN ('RESOLVED', 'CLOSED')
    AND packet_item.value->>'orderItemId' = i.id
    AND nullif(packet_item.value->>'reference', '') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.supplier_packet_attempt attempt
      WHERE attempt.packet_id = p.id AND lower(attempt.recipient) = lower(p.recipient)
        AND (
          (attempt.type = 'SEND' AND (
            (attempt.state IN ('ACCEPTED', 'DELIVERY_ISSUE') AND attempt.accepted_at IS NOT NULL)
            OR (attempt.state = 'DELIVERED' AND attempt.delivered_at IS NOT NULL)
          ))
          OR (attempt.type IN ('MANUAL_SENT', 'MANUAL_SEND') AND attempt.state = 'MANUAL_SENT' AND attempt.sent_at IS NOT NULL)
        )
    )
  ORDER BY p.version DESC, p.created_at DESC, p.id DESC
  LIMIT 1 FOR SHARE OF c;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_supplier_notice_dispatch(text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_supplier_notice_dispatch(text,text) TO gphkm_runtime;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_supplier_item_notice_access(target_notice_id text, target_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.supplier_item_notice n
    JOIN public.support_case c ON c.id = n.case_id
    JOIN public.customer_order_item i ON i.id = n.order_item_id AND i.order_id = c.order_id
    JOIN public.order_item_fulfillment f ON f.order_item_id = i.id
    WHERE n.id = target_notice_id AND (
      public.gphkm_is_active_staff(target_user_id, 'SUPER_ADMIN')
      OR (f.assigned_admin_id = target_user_id AND public.gphkm_is_active_staff(target_user_id, 'ADMIN'))
    )
  )
$$;
--> statement-breakpoint
DROP POLICY supplier_item_notice_staff_read ON public.supplier_item_notice;
--> statement-breakpoint
CREATE POLICY supplier_item_notice_staff_read ON public.supplier_item_notice FOR SELECT TO gphkm_runtime USING (
  public.gphkm_supplier_item_notice_access(id, nullif(current_setting('app.user_id', true), ''))
);
--> statement-breakpoint
DROP POLICY supplier_item_notice_staff_insert ON public.supplier_item_notice;
--> statement-breakpoint
CREATE POLICY supplier_item_notice_staff_insert ON public.supplier_item_notice FOR INSERT TO gphkm_runtime WITH CHECK (
  created_by_user_id = nullif(current_setting('app.user_id', true), '')
  AND (public.gphkm_is_active_staff(created_by_user_id, 'ADMIN') OR public.gphkm_is_active_staff(created_by_user_id, 'SUPER_ADMIN'))
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_supplier_notice_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE dispatch record;
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.created_by_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '') THEN
    RAISE EXCEPTION 'supplier notice snapshot is immutable' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO dispatch FROM public.gphkm_supplier_notice_dispatch(NEW.case_id, NEW.order_item_id);
  IF NOT FOUND OR NEW.packet_id IS DISTINCT FROM dispatch.packet_id OR NEW.recipient IS DISTINCT FROM dispatch.recipient
    OR NEW.snapshot->>'itemReference' IS DISTINCT FROM dispatch.item_reference
    OR NEW.content_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'supplier notice requires current-route dispatch evidence and the assigned item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- The runtime cannot update immutable snapshots. Lock the authorized notice
-- and item without granting UPDATE, so send/export and reassignment serialize.
CREATE FUNCTION public.gphkm_lock_supplier_item_notice(target_notice text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), '');
BEGIN
  PERFORM n.id FROM public.supplier_item_notice n
  JOIN public.order_item_fulfillment f ON f.order_item_id = n.order_item_id
  WHERE n.id = target_notice AND (
    public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')
    OR (f.assigned_admin_id = actor_id AND public.gphkm_is_active_staff(actor_id, 'ADMIN'))
  )
  FOR UPDATE OF n, f;
  RETURN FOUND;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_lock_supplier_item_notice(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_lock_supplier_item_notice(text) TO gphkm_runtime;
