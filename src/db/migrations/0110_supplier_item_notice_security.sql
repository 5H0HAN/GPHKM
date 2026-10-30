REVOKE ALL ON public.supplier_item_notice, public.supplier_item_notice_attempt, public.supplier_item_notice_event FROM PUBLIC;
GRANT SELECT, INSERT ON public.supplier_item_notice TO gphkm_runtime;
GRANT SELECT, INSERT, UPDATE ON public.supplier_item_notice_attempt TO gphkm_runtime;
GRANT SELECT, INSERT ON public.supplier_item_notice_event TO gphkm_runtime;

CREATE FUNCTION public.gphkm_supplier_item_notice_access(target_notice_id text, target_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.supplier_item_notice n
    JOIN public.support_case c ON c.id = n.case_id AND c.order_item_id = n.order_item_id
    JOIN public.order_item_fulfillment f ON f.order_item_id = n.order_item_id
    WHERE n.id = target_notice_id
      AND f.handed_off_at IS NOT NULL
      AND public.gphkm_supplier_packet_access(n.packet_id, target_user_id)
      AND (f.assigned_admin_id = target_user_id OR public.gphkm_is_active_staff(target_user_id,'SUPER_ADMIN'))
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_item_notice_access(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_supplier_item_notice_access(text,text) TO gphkm_runtime;

CREATE POLICY supplier_item_notice_staff_read ON public.supplier_item_notice FOR SELECT TO gphkm_runtime USING (
  public.gphkm_supplier_packet_access(packet_id, nullif(current_setting('app.user_id',true),''))
  AND EXISTS (SELECT 1 FROM public.support_case c JOIN public.order_item_fulfillment f ON f.order_item_id = c.order_item_id
    WHERE c.id = case_id AND c.order_item_id = supplier_item_notice.order_item_id AND f.handed_off_at IS NOT NULL
      AND (f.assigned_admin_id = nullif(current_setting('app.user_id',true),'') OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id',true),''),'SUPER_ADMIN')))
);
CREATE POLICY supplier_item_notice_staff_insert ON public.supplier_item_notice FOR INSERT TO gphkm_runtime WITH CHECK (
  created_by_user_id = nullif(current_setting('app.user_id',true),'')
  AND public.gphkm_supplier_packet_access(packet_id, created_by_user_id)
  AND EXISTS (SELECT 1 FROM public.support_case c JOIN public.order_item_fulfillment f ON f.order_item_id = c.order_item_id
    WHERE c.id = case_id AND c.order_item_id = supplier_item_notice.order_item_id AND f.handed_off_at IS NOT NULL
      AND (f.assigned_admin_id = created_by_user_id OR public.gphkm_is_active_staff(created_by_user_id,'SUPER_ADMIN')))
  AND (public.gphkm_is_active_staff(created_by_user_id,'ADMIN') OR public.gphkm_is_active_staff(created_by_user_id,'SUPER_ADMIN'))
);

CREATE POLICY supplier_item_notice_attempt_read ON public.supplier_item_notice_attempt FOR SELECT TO gphkm_runtime USING (
  public.gphkm_supplier_item_notice_access(notice_id, nullif(current_setting('app.user_id',true),''))
);
CREATE POLICY supplier_item_notice_attempt_insert ON public.supplier_item_notice_attempt FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id',true),'')
  AND public.gphkm_supplier_item_notice_access(notice_id, actor_user_id)
);
CREATE POLICY supplier_item_notice_attempt_update ON public.supplier_item_notice_attempt FOR UPDATE TO gphkm_runtime USING (
  public.gphkm_supplier_item_notice_access(notice_id, nullif(current_setting('app.user_id',true),''))
) WITH CHECK (public.gphkm_supplier_item_notice_access(notice_id, nullif(current_setting('app.user_id',true),'')));
CREATE POLICY supplier_item_notice_event_read ON public.supplier_item_notice_event FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM public.supplier_item_notice_attempt a WHERE a.id = attempt_id
    AND public.gphkm_supplier_item_notice_access(a.notice_id, nullif(current_setting('app.user_id',true),'')))
);
CREATE POLICY supplier_item_notice_event_insert ON public.supplier_item_notice_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_kind = 'STAFF' AND actor_user_id = nullif(current_setting('app.user_id',true),'')
  AND EXISTS (SELECT 1 FROM public.supplier_item_notice_attempt a WHERE a.id = attempt_id
    AND public.gphkm_supplier_item_notice_access(a.notice_id, actor_user_id))
);

CREATE FUNCTION public.gphkm_supplier_notice_immutable_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'supplier notice snapshots and events are append-only' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_notice_immutable_guard() FROM PUBLIC;
CREATE TRIGGER supplier_item_notice_immutable BEFORE UPDATE OR DELETE ON public.supplier_item_notice
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_notice_immutable_guard();
CREATE TRIGGER supplier_item_notice_event_immutable BEFORE UPDATE OR DELETE ON public.supplier_item_notice_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_notice_immutable_guard();

CREATE FUNCTION public.gphkm_supplier_notice_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE packet_row public.supplier_packet%ROWTYPE; case_item text; assigned_admin text;
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.created_by_user_id IS DISTINCT FROM nullif(current_setting('app.user_id',true),'') THEN
    RAISE EXCEPTION 'supplier notice snapshot is immutable' USING ERRCODE = '42501';
  END IF;
  SELECT c.order_item_id INTO case_item FROM public.support_case c WHERE c.id = NEW.case_id;
  SELECT f.assigned_admin_id INTO assigned_admin FROM public.order_item_fulfillment f
    WHERE f.order_item_id = NEW.order_item_id AND f.handed_off_at IS NOT NULL;
  SELECT * INTO packet_row FROM public.supplier_packet WHERE id = NEW.packet_id;
  IF case_item IS DISTINCT FROM NEW.order_item_id OR assigned_admin IS NULL OR packet_row.id IS NULL
     OR packet_row.recipient IS DISTINCT FROM NEW.recipient
     OR NOT EXISTS (SELECT 1 FROM public.supplier_packet_item pi
       WHERE pi.packet_id = NEW.packet_id AND pi.order_item_id = NEW.order_item_id
         AND pi.assigned_admin_id = assigned_admin)
     OR NEW.content_hash !~ '^[0-9a-f]{64}$'
     OR (public.gphkm_is_active_staff(NEW.created_by_user_id,'ADMIN') AND assigned_admin IS DISTINCT FROM NEW.created_by_user_id)
     OR NOT (public.gphkm_is_active_staff(NEW.created_by_user_id,'ADMIN') OR public.gphkm_is_active_staff(NEW.created_by_user_id,'SUPER_ADMIN')) THEN
    RAISE EXCEPTION 'supplier notice does not match handed-off assignment and packet' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_notice_insert_guard() FROM PUBLIC;
CREATE TRIGGER supplier_item_notice_insert_guard BEFORE INSERT ON public.supplier_item_notice
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_notice_insert_guard();

CREATE FUNCTION public.gphkm_supplier_notice_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'UPDATE'
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.notice_id IS DISTINCT FROM OLD.notice_id
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NOT ((OLD.state = 'SENDING' AND NEW.state IN ('ACCEPTED','UNKNOWN','RECONCILED_FAILED'))
       OR (OLD.state = 'UNKNOWN' AND NEW.state IN ('ACCEPTED','RECONCILED_FAILED'))
       OR (OLD.state IN ('ACCEPTED','MANUAL_SENT') AND NEW.state IN ('SUPPLIER_STOP_CONFIRMED','SUPPLIER_CONTINUING','UNABLE_TO_CONFIRM'))) THEN
    RAISE EXCEPTION 'invalid supplier notice attempt transition' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_notice_attempt_guard() FROM PUBLIC;
CREATE TRIGGER supplier_item_notice_attempt_guard BEFORE UPDATE OR DELETE ON public.supplier_item_notice_attempt
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_notice_attempt_guard();

REVOKE DELETE ON public.supplier_item_notice, public.supplier_item_notice_attempt, public.supplier_item_notice_event FROM gphkm_runtime;
REVOKE UPDATE, DELETE ON public.supplier_item_notice, public.supplier_item_notice_event FROM gphkm_runtime;
