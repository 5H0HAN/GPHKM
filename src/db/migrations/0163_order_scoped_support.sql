ALTER TABLE "supplier_item_notice" DROP CONSTRAINT "supplier_item_notice_repeat_uq";--> statement-breakpoint
DROP INDEX "support_case_item_idx";--> statement-breakpoint
ALTER TABLE "support_case" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "support_case" ALTER COLUMN "order_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "support_case" ADD COLUMN "merged_into_case_id" text;--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_merged_into_case_id_support_case_id_fk" FOREIGN KEY ("merged_into_case_id") REFERENCES "public"."support_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_case_merged_into_idx" ON "support_case" USING btree ("merged_into_case_id") WHERE "support_case"."merged_into_case_id" is not null;--> statement-breakpoint
CREATE INDEX "support_case_item_idx" ON "support_case" USING btree ("order_item_id") WHERE "support_case"."order_item_id" is not null;--> statement-breakpoint
ALTER TABLE "supplier_item_notice" ADD CONSTRAINT "supplier_item_notice_repeat_uq" UNIQUE("case_id","order_item_id","notice_type","content_hash");--> statement-breakpoint

-- Consolidate existing active per-item conversations without deleting history.
-- The most operationally relevant case survives; earlier case IDs redirect to it.
CREATE TEMP TABLE support_case_merge_map ON COMMIT DROP AS
WITH ranked AS (
  SELECT c.id, first_value(c.id) OVER (
    PARTITION BY c.order_id
    ORDER BY
      EXISTS (SELECT 1 FROM public.post_handoff_refund_request refund WHERE refund.case_id = c.id AND refund.state = 'REQUESTED') DESC,
      (c.state = 'FINANCE_REVIEW') DESC,
      EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome WHERE outcome.support_case_id = c.id) DESC,
      c.updated_at DESC, c.id
  ) AS canonical_id,
  row_number() OVER (
    PARTITION BY c.order_id
    ORDER BY
      EXISTS (SELECT 1 FROM public.post_handoff_refund_request refund WHERE refund.case_id = c.id AND refund.state = 'REQUESTED') DESC,
      (c.state = 'FINANCE_REVIEW') DESC,
      EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome WHERE outcome.support_case_id = c.id) DESC,
      c.updated_at DESC, c.id
  ) AS position
  FROM public.support_case c
  WHERE c.order_id IS NOT NULL AND c.merged_into_case_id IS NULL AND c.state NOT IN ('RESOLVED','CLOSED')
)
SELECT id AS source_id, canonical_id FROM ranked WHERE position > 1;--> statement-breakpoint

ALTER TABLE public.support_case DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE public.support_case_event DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE public.supplier_fulfillment_outcome DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE public.order_item_equivalent_offer DISABLE TRIGGER USER;--> statement-breakpoint

UPDATE public.support_case_event event SET
  kind = CASE WHEN event.actor_kind = 'CUSTOMER' THEN 'REPLY' ELSE 'NOTE' END,
  audience = CASE WHEN event.actor_kind = 'CUSTOMER' THEN 'CUSTOMER' ELSE 'INTERNAL' END,
  from_state = NULL, to_state = NULL, decision = NULL
FROM support_case_merge_map mapping
WHERE event.case_id = mapping.source_id AND event.kind = 'OPENED';--> statement-breakpoint

UPDATE public.supplier_fulfillment_outcome child SET support_case_id = mapping.canonical_id
FROM support_case_merge_map mapping WHERE child.support_case_id = mapping.source_id;--> statement-breakpoint
UPDATE public.order_item_equivalent_offer child SET support_case_id = mapping.canonical_id
FROM support_case_merge_map mapping WHERE child.support_case_id = mapping.source_id;--> statement-breakpoint
UPDATE public.support_case source SET state = 'CLOSED', merged_into_case_id = mapping.canonical_id, updated_at = clock_timestamp()
FROM support_case_merge_map mapping WHERE source.id = mapping.source_id;--> statement-breakpoint

ALTER TABLE public.order_item_equivalent_offer ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE public.supplier_fulfillment_outcome ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE public.support_case_event ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE public.support_case ENABLE TRIGGER USER;--> statement-breakpoint

CREATE UNIQUE INDEX support_case_active_order_uq ON public.support_case(order_id)
  WHERE order_id IS NOT NULL AND state NOT IN ('RESOLVED','CLOSED');--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_customer_can_read_order(target_order_id text, target_user_id text, target_org_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.customer_order o
    WHERE o.id = target_order_id AND o.organization_id = target_org_id AND o.checkout_state = 'PAID'
      AND public.gphkm_is_active_org_member(target_org_id, target_user_id)
      AND (public.gphkm_is_active_org_owner(target_org_id, target_user_id) OR o.actor_user_id = target_user_id)
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_customer_can_read_order(text,text,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_customer_can_read_order(text,text,text) TO gphkm_runtime;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_support_customer_access(target_case text, target_user text, target_org text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.support_case requested
    LEFT JOIN public.customer_order order_row ON order_row.id = requested.order_id
    WHERE requested.id = target_case AND requested.organization_id = target_org
      AND public.gphkm_is_active_org_member(target_org, target_user)
      AND (
        (requested.merged_into_case_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.support_case c LEFT JOIN public.customer_order o ON o.id = c.order_id
          WHERE c.id = requested.merged_into_case_id AND c.organization_id = target_org
            AND (public.gphkm_is_active_org_owner(target_org, target_user) OR c.opened_by_user_id = target_user OR o.actor_user_id = target_user)
        ))
        OR (requested.merged_into_case_id IS NULL AND requested.order_id IS NULL
          AND (public.gphkm_is_active_org_owner(target_org, target_user) OR requested.opened_by_user_id = target_user))
        OR (requested.merged_into_case_id IS NULL AND requested.order_id IS NOT NULL
          AND (public.gphkm_is_active_org_owner(target_org, target_user) OR requested.opened_by_user_id = target_user
            OR order_row.actor_user_id = target_user))
      )
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_support_customer_access(text,text,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_support_customer_access(text,text,text) TO gphkm_runtime;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_support_admin_access(target_case text, target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_is_active_staff(target_user, 'SUPER_ADMIN') OR (
    public.gphkm_is_active_staff(target_user, 'ADMIN') AND EXISTS (
      SELECT 1 FROM public.support_case requested
      JOIN public.support_case c ON c.id = coalesce(requested.merged_into_case_id, requested.id)
      WHERE requested.id = target_case AND (
        c.order_id IS NULL OR EXISTS (
          SELECT 1 FROM public.customer_order_item i
          JOIN public.order_item_fulfillment f ON f.order_item_id = i.id
          WHERE i.order_id = c.order_id AND f.assigned_admin_id = target_user
        )
      )
    )
  )
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.gphkm_support_finance_access(target_case text, target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_is_active_staff(target_user, 'FINANCE') AND EXISTS (
    SELECT 1 FROM public.support_case requested
    JOIN public.support_case c ON c.id = coalesce(requested.merged_into_case_id, requested.id)
    WHERE requested.id = target_case AND c.state = 'FINANCE_REVIEW'
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_support_admin_access(text,text), public.gphkm_support_finance_access(text,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_support_admin_access(text,text), public.gphkm_support_finance_access(text,text) TO gphkm_runtime;--> statement-breakpoint

-- Keep customer order items scoped to the customer or exact staff assignment.
DROP POLICY customer_order_item_read ON public.customer_order_item;--> statement-breakpoint
CREATE POLICY customer_order_item_read ON public.customer_order_item FOR SELECT TO gphkm_runtime USING (
  NOT public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''))
  AND public.gphkm_customer_can_read_order_item(id,
    nullif(current_setting('app.user_id', true), ''), nullif(current_setting('app.organization_id', true), ''))
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_support_case_placement_count(target_case_id text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN case_row.order_id IS NULL THEN 0 ELSE (
    SELECT count(*)::integer FROM public.customer_order_item item WHERE item.order_id = case_row.order_id
  ) END
  FROM public.support_case case_row
  WHERE case_row.id = target_case_id AND (
    public.gphkm_support_admin_access(case_row.id, nullif(current_setting('app.user_id', true), ''))
    OR public.gphkm_support_finance_access(case_row.id, nullif(current_setting('app.user_id', true), ''))
    OR public.gphkm_support_customer_access(case_row.id,
      nullif(current_setting('app.user_id', true), ''), nullif(current_setting('app.organization_id', true), ''))
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_support_case_placement_count(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_support_case_placement_count(text) TO gphkm_runtime;--> statement-breakpoint

DROP POLICY support_case_customer_open ON public.support_case;--> statement-breakpoint
CREATE POLICY support_case_customer_open ON public.support_case FOR INSERT TO gphkm_runtime WITH CHECK (
  organization_id = nullif(current_setting('app.organization_id',true),'')
  AND opened_by_user_id = nullif(current_setting('app.user_id',true),'') AND state = 'OPEN'
  AND merged_into_case_id IS NULL
  AND ((order_id IS NULL AND order_item_id IS NULL AND public.gphkm_is_active_org_member(organization_id, opened_by_user_id))
    OR (order_id IS NOT NULL AND public.gphkm_customer_can_read_order(order_id, opened_by_user_id, organization_id)
      AND (order_item_id IS NULL OR EXISTS (SELECT 1 FROM public.customer_order_item i WHERE i.id = order_item_id AND i.order_id = order_id))))
);--> statement-breakpoint
DROP POLICY post_handoff_refund_admin_read ON public.post_handoff_refund_request;--> statement-breakpoint
CREATE POLICY post_handoff_refund_admin_read ON public.post_handoff_refund_request FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id',true),''),'SUPER_ADMIN')
  OR (public.gphkm_is_active_staff(nullif(current_setting('app.user_id',true),''),'ADMIN')
    AND public.gphkm_support_admin_access(case_id, nullif(current_setting('app.user_id',true),''))
    AND EXISTS (SELECT 1 FROM public.order_item_fulfillment f
      WHERE f.order_item_id = post_handoff_refund_request.order_item_id
        AND f.assigned_admin_id = nullif(current_setting('app.user_id',true),'')))
);--> statement-breakpoint
DROP POLICY support_case_supplier_outcome_open ON public.support_case;--> statement-breakpoint
CREATE POLICY support_case_supplier_outcome_open ON public.support_case FOR INSERT TO gphkm_runtime WITH CHECK (
  state = 'OPEN' AND merged_into_case_id IS NULL AND order_id IS NOT NULL AND order_item_id IS NOT NULL
  AND opened_by_user_id = (SELECT o.actor_user_id FROM public.customer_order o WHERE o.id = support_case.order_id)
  AND EXISTS (SELECT 1 FROM public.customer_order_item i WHERE i.id = order_item_id AND i.order_id = support_case.order_id)
  AND public.gphkm_staff_can_read_order_item(order_item_id, nullif(current_setting('app.user_id',true),''))
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_support_case_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actual_org text; actual_order text; actor_id text := nullif(current_setting('app.user_id',true),'');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.merged_into_case_id IS NOT NULL OR (NEW.order_id IS NULL AND NEW.order_item_id IS NOT NULL) THEN
      RAISE EXCEPTION 'invalid Support case scope' USING ERRCODE = '23514';
    END IF;
    IF NEW.order_id IS NOT NULL THEN
      SELECT o.organization_id, o.id INTO actual_org, actual_order FROM public.customer_order o
       WHERE o.id = NEW.order_id AND o.checkout_state = 'PAID';
      IF NOT FOUND OR actual_org <> NEW.organization_id THEN RAISE EXCEPTION 'Support order unavailable' USING ERRCODE = '23514'; END IF;
      IF NEW.order_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customer_order_item i
        WHERE i.id = NEW.order_item_id AND i.order_id = NEW.order_id) THEN
        RAISE EXCEPTION 'Support order/item mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    IF (NEW.id,NEW.organization_id,NEW.order_id,NEW.order_item_id,NEW.merged_into_case_id,NEW.opened_by_user_id,NEW.summary,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
       IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.order_id,OLD.order_item_id,OLD.merged_into_case_id,OLD.opened_by_user_id,OLD.summary,OLD.idempotency_key,OLD.request_hash,OLD.created_at) THEN
      RAISE EXCEPTION 'Support case identity and opening are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.state <> OLD.state AND NOT (
      (OLD.state = 'OPEN' AND NEW.state IN ('INVESTIGATING','WAITING_ON_CUSTOMER','WAITING_ON_SUPPLIER','FINANCE_REVIEW','RESOLVED','CLOSED'))
      OR (OLD.state = 'INVESTIGATING' AND NEW.state IN ('WAITING_ON_CUSTOMER','WAITING_ON_SUPPLIER','FINANCE_REVIEW','RESOLVED','CLOSED'))
      OR (OLD.state IN ('WAITING_ON_CUSTOMER','WAITING_ON_SUPPLIER') AND NEW.state IN ('INVESTIGATING','FINANCE_REVIEW','RESOLVED','CLOSED'))
      OR (OLD.state = 'FINANCE_REVIEW' AND NEW.state = 'INVESTIGATING') OR (OLD.state = 'RESOLVED' AND NEW.state = 'CLOSED')
    ) THEN RAISE EXCEPTION 'invalid Support state transition' USING ERRCODE = '23514'; END IF;
    IF NEW.state <> OLD.state AND OLD.state = 'FINANCE_REVIEW' THEN
      IF NEW.state <> 'INVESTIGATING' OR NOT (public.gphkm_is_active_staff(actor_id,'FINANCE') OR public.gphkm_is_active_staff(actor_id,'SUPER_ADMIN'))
        OR NOT EXISTS (SELECT 1 FROM public.support_case_event e WHERE e.case_id = OLD.id AND e.actor_user_id = actor_id
          AND e.kind = 'FINANCE_DECISION' AND e.created_at >= transaction_timestamp()) THEN
        RAISE EXCEPTION 'Finance review requires a recorded decision' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF NEW.state <> OLD.state AND NOT EXISTS (SELECT 1 FROM public.support_case_event e
      WHERE e.case_id = OLD.id AND e.actor_user_id = actor_id AND e.kind = 'STATE_CHANGED'
        AND e.from_state = OLD.state AND e.to_state = NEW.state AND e.created_at >= transaction_timestamp()) THEN
      RAISE EXCEPTION 'Support state change requires append-only history' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP POLICY supplier_fulfillment_outcome_assigned_insert ON public.supplier_fulfillment_outcome;--> statement-breakpoint
CREATE POLICY supplier_fulfillment_outcome_assigned_insert ON public.supplier_fulfillment_outcome FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id',true),'')
  AND public.gphkm_staff_can_read_order_item(order_item_id, actor_user_id)
  AND EXISTS (SELECT 1 FROM public.order_item_fulfillment_supplier s WHERE s.order_item_id = supplier_fulfillment_outcome.order_item_id AND s.supplier_id = supplier_fulfillment_outcome.supplier_id)
  AND EXISTS (SELECT 1 FROM public.customer_order_item i JOIN public.support_case c ON c.order_id = i.order_id
    WHERE i.id = supplier_fulfillment_outcome.order_item_id AND c.id = supplier_fulfillment_outcome.support_case_id
      AND c.state NOT IN ('RESOLVED','CLOSED') AND c.merged_into_case_id IS NULL)
);--> statement-breakpoint

DROP POLICY equivalent_offer_staff_insert ON public.order_item_equivalent_offer;--> statement-breakpoint
CREATE POLICY equivalent_offer_staff_insert ON public.order_item_equivalent_offer FOR INSERT TO gphkm_runtime WITH CHECK (
  offered_by_user_id = nullif(current_setting('app.user_id',true),'')
  AND public.gphkm_staff_can_read_order_item(order_item_id, offered_by_user_id)
  AND EXISTS (SELECT 1 FROM public.customer_order_item i JOIN public.support_case c ON c.order_id = i.order_id
    WHERE i.id = order_item_id AND c.id = support_case_id AND c.state NOT IN ('RESOLVED','CLOSED') AND c.merged_into_case_id IS NULL)
  AND EXISTS (SELECT 1 FROM public.customer_order_item i WHERE i.id = order_item_id AND i.placement_price_minor + i.writing_price_minor = locked_price_minor)
  AND EXISTS (SELECT 1 FROM public.order_item_content_change_request r WHERE r.id = content_request_id AND r.order_item_id = order_item_id AND r.target_supplier_id IS NOT NULL)
);--> statement-breakpoint

DROP POLICY content_change_request_equivalent_insert ON public.order_item_content_change_request;--> statement-breakpoint
CREATE POLICY content_change_request_equivalent_insert ON public.order_item_content_change_request FOR INSERT TO gphkm_runtime WITH CHECK (
  target_supplier_id IS NOT NULL
  AND public.gphkm_staff_can_read_order_item(order_item_id, nullif(current_setting('app.user_id',true),''))
  AND requested_by_user_id = (SELECT o.actor_user_id FROM public.customer_order_item i JOIN public.customer_order o ON o.id = i.order_id WHERE i.id = order_item_id)
  AND EXISTS (SELECT 1 FROM public.customer_order_item i JOIN public.support_case c ON c.order_id = i.order_id
    WHERE i.id = order_item_id AND c.state NOT IN ('RESOLVED','CLOSED') AND c.merged_into_case_id IS NULL)
  AND EXISTS (SELECT 1 FROM public.supplier s JOIN public.supplier_contact sc ON sc.supplier_id = s.id WHERE s.id = target_supplier_id AND s.status = 'ACTIVE' AND sc.is_primary)
);--> statement-breakpoint
DROP POLICY content_version_equivalent_insert ON public.order_item_content_version;--> statement-breakpoint
CREATE POLICY content_version_equivalent_insert ON public.order_item_content_version FOR INSERT TO gphkm_runtime WITH CHECK (
  approved_by_user_id = nullif(current_setting('app.user_id',true),'')
  AND public.gphkm_staff_can_read_order_item(order_item_id, approved_by_user_id)
  AND EXISTS (SELECT 1 FROM public.order_item_content_change_request r WHERE r.id = request_id AND r.order_item_id = order_item_id AND r.target_supplier_id = supplier_id)
  AND EXISTS (SELECT 1 FROM public.customer_order_item i JOIN public.support_case c ON c.order_id = i.order_id
    WHERE i.id = order_item_id AND c.state NOT IN ('RESOLVED','CLOSED') AND c.merged_into_case_id IS NULL)
);--> statement-breakpoint

DROP POLICY supplier_item_notice_staff_read ON public.supplier_item_notice;--> statement-breakpoint
CREATE POLICY supplier_item_notice_staff_read ON public.supplier_item_notice FOR SELECT TO gphkm_runtime USING (
  public.gphkm_supplier_packet_access(packet_id, nullif(current_setting('app.user_id',true),''))
  AND EXISTS (SELECT 1 FROM public.support_case c JOIN public.customer_order_item i ON i.order_id = c.order_id
    JOIN public.order_item_fulfillment f ON f.order_item_id = i.id
    WHERE c.id = case_id AND c.state NOT IN ('RESOLVED','CLOSED')
      AND i.id = supplier_item_notice.order_item_id
      AND (f.assigned_admin_id = nullif(current_setting('app.user_id',true),'') OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id',true),''),'SUPER_ADMIN')))
);--> statement-breakpoint
DROP POLICY supplier_item_notice_staff_insert ON public.supplier_item_notice;--> statement-breakpoint
CREATE POLICY supplier_item_notice_staff_insert ON public.supplier_item_notice FOR INSERT TO gphkm_runtime WITH CHECK (
  created_by_user_id = nullif(current_setting('app.user_id',true),'')
  AND public.gphkm_supplier_packet_access(packet_id, created_by_user_id)
  AND EXISTS (SELECT 1 FROM public.support_case c JOIN public.customer_order_item i ON i.order_id = c.order_id
    JOIN public.order_item_fulfillment f ON f.order_item_id = i.id
    JOIN public.order_item_fulfillment_supplier route ON route.order_item_id = i.id
    JOIN public.supplier_packet p ON p.id = supplier_item_notice.packet_id
    JOIN public.supplier_packet_item pi ON pi.packet_id = p.id AND pi.order_item_id = i.id
    WHERE c.id = case_id AND i.id = supplier_item_notice.order_item_id
      AND route.supplier_id = p.supplier_id AND route.route_generation = pi.route_generation
      AND EXISTS (SELECT 1 FROM public.supplier_packet_attempt attempt WHERE attempt.packet_id = p.id
        AND lower(attempt.recipient) = lower(p.recipient)
        AND ((attempt.type = 'SEND' AND attempt.state = 'DELIVERED' AND attempt.delivered_at IS NOT NULL)
          OR (attempt.type IN ('MANUAL_SENT','MANUAL_SEND') AND attempt.state = 'MANUAL_SENT' AND attempt.sent_at IS NOT NULL)))
      AND (f.assigned_admin_id = created_by_user_id OR public.gphkm_is_active_staff(created_by_user_id,'SUPER_ADMIN')))
  AND (public.gphkm_is_active_staff(created_by_user_id,'ADMIN') OR public.gphkm_is_active_staff(created_by_user_id,'SUPER_ADMIN'))
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_supplier_item_notice_access(target_notice_id text, target_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.supplier_item_notice n
    JOIN public.support_case c ON c.id = n.case_id
    JOIN public.customer_order_item i ON i.id = n.order_item_id AND i.order_id = c.order_id
    JOIN public.order_item_fulfillment f ON f.order_item_id = n.order_item_id
    WHERE n.id = target_notice_id
      AND public.gphkm_supplier_packet_access(n.packet_id, target_user_id)
      AND (f.assigned_admin_id = target_user_id OR public.gphkm_is_active_staff(target_user_id,'SUPER_ADMIN'))
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_supplier_item_notice_access(text,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_supplier_item_notice_access(text,text) TO gphkm_runtime;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_supplier_notice_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE packet_row public.supplier_packet%ROWTYPE; case_order text; assigned_admin text;
  route_supplier_id text; route_generation_value integer;
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.created_by_user_id IS DISTINCT FROM nullif(current_setting('app.user_id',true),'') THEN
    RAISE EXCEPTION 'supplier notice snapshot is immutable' USING ERRCODE = '42501';
  END IF;
  SELECT c.order_id INTO case_order FROM public.support_case c
    WHERE c.id = NEW.case_id AND c.merged_into_case_id IS NULL AND c.state NOT IN ('RESOLVED','CLOSED');
  SELECT f.assigned_admin_id INTO assigned_admin FROM public.order_item_fulfillment f
    WHERE f.order_item_id = NEW.order_item_id FOR UPDATE;
  SELECT fs.supplier_id, fs.route_generation INTO route_supplier_id, route_generation_value
    FROM public.order_item_fulfillment_supplier fs WHERE fs.order_item_id = NEW.order_item_id FOR KEY SHARE;
  SELECT * INTO packet_row FROM public.supplier_packet WHERE id = NEW.packet_id;
  IF case_order IS NULL OR NOT EXISTS (SELECT 1 FROM public.customer_order_item i WHERE i.id = NEW.order_item_id AND i.order_id = case_order)
     OR assigned_admin IS NULL OR packet_row.id IS NULL OR packet_row.recipient IS DISTINCT FROM NEW.recipient
     OR packet_row.supplier_id IS DISTINCT FROM route_supplier_id
     OR NOT EXISTS (SELECT 1 FROM public.supplier_packet_item pi WHERE pi.packet_id = NEW.packet_id
       AND pi.order_item_id = NEW.order_item_id AND pi.assigned_admin_id = assigned_admin
       AND pi.route_generation = route_generation_value)
     OR NOT EXISTS (SELECT 1 FROM public.supplier_packet_attempt attempt WHERE attempt.packet_id = NEW.packet_id
       AND lower(attempt.recipient) = lower(packet_row.recipient)
       AND ((attempt.type = 'SEND' AND attempt.state = 'DELIVERED' AND attempt.delivered_at IS NOT NULL)
         OR (attempt.type IN ('MANUAL_SENT','MANUAL_SEND') AND attempt.state = 'MANUAL_SENT' AND attempt.sent_at IS NOT NULL)))
     OR NEW.content_hash !~ '^[0-9a-f]{64}$'
     OR (public.gphkm_is_active_staff(NEW.created_by_user_id,'ADMIN') AND assigned_admin IS DISTINCT FROM NEW.created_by_user_id)
     OR NOT (public.gphkm_is_active_staff(NEW.created_by_user_id,'ADMIN') OR public.gphkm_is_active_staff(NEW.created_by_user_id,'SUPER_ADMIN')) THEN
    RAISE EXCEPTION 'supplier notice requires current-route delivery evidence and the assigned item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint


-- Reinstall the current route guards with order-scoped Support semantics.
CREATE OR REPLACE FUNCTION public.gphkm_validate_content_change_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE fulfillment_row public.order_item_fulfillment%ROWTYPE; actor_id text := nullif(current_setting('app.user_id',true),'');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.customer_order_item oi WHERE oi.id = NEW.order_item_id) THEN RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment f WHERE f.order_item_id = NEW.order_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '23514'; END IF;
  IF NEW.target_supplier_id IS NULL THEN
    IF fulfillment_row.handed_off_at IS NOT NULL OR fulfillment_row.state IN ('IN_FULFILLMENT','PUBLICATION_PENDING','EVIDENCE_REVIEW','COMPLETED','CANCELED_REFUNDED') THEN
      RAISE EXCEPTION 'content changes close after handoff' USING ERRCODE = '23514';
    END IF;
  ELSIF fulfillment_row.state IN ('COMPLETED','CANCELED_REFUNDED')
    OR NOT public.gphkm_staff_can_read_order_item(NEW.order_item_id, actor_id)
    OR NOT EXISTS (SELECT 1 FROM public.support_case c WHERE c.order_id = (SELECT item.order_id FROM public.customer_order_item item WHERE item.id = NEW.order_item_id) AND c.state NOT IN ('RESOLVED','CLOSED'))
    OR NOT EXISTS (SELECT 1 FROM public.supplier s JOIN public.supplier_contact sc ON sc.supplier_id = s.id WHERE s.id = NEW.target_supplier_id AND s.status = 'ACTIVE' AND sc.is_primary) THEN
    RAISE EXCEPTION 'equivalent content route is unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_reject_equivalent_offer_event_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE offer_item_id text; offer_state text; current_supplier_id text; target_supplier_id text;
  current_generation integer; target_generation integer;
  support_case_ref text; last_item_event timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'equivalent offer history is append-only' USING ERRCODE = '42501';
  END IF;
  SELECT o.order_item_id, o.support_case_id, r.supplier_id, r.route_generation
    INTO offer_item_id, support_case_ref, target_supplier_id, target_generation
    FROM public.order_item_equivalent_offer o
    JOIN public.order_item_equivalent_offer_route r ON r.offer_id = o.id
   WHERE o.id = NEW.offer_id;
  IF offer_item_id IS NULL THEN RAISE EXCEPTION 'equivalent offer route is unavailable' USING ERRCODE = '23514'; END IF;

  -- The shared item lock serializes competing offer events and acceptance.
  PERFORM 1 FROM public.order_item_fulfillment f WHERE f.order_item_id = offer_item_id FOR UPDATE;
  SELECT fs.supplier_id, fs.route_generation INTO current_supplier_id, current_generation FROM public.order_item_fulfillment_supplier fs
    WHERE fs.order_item_id = offer_item_id FOR KEY SHARE;
  IF current_supplier_id IS NULL OR current_supplier_id = target_supplier_id OR target_generation <> current_generation + 1 THEN
    RAISE EXCEPTION 'equivalent offer route is no longer current' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(offer_item_id, 0));

  SELECT e.event_type INTO offer_state FROM public.order_item_equivalent_offer_event e
    WHERE e.offer_id = NEW.offer_id ORDER BY e.created_at DESC, e.id DESC LIMIT 1;
  IF NEW.event_type NOT IN ('OFFERED','ACCEPTED','DECLINED') THEN
    RAISE EXCEPTION 'equivalent offer event is invalid' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.support_case c
    JOIN public.supplier_fulfillment_outcome outcome ON outcome.support_case_id = c.id
    WHERE c.id = support_case_ref AND EXISTS (SELECT 1 FROM public.customer_order_item item WHERE item.id = offer_item_id AND item.order_id = c.order_id)
      AND c.state NOT IN ('RESOLVED','CLOSED')
      AND outcome.order_item_id = offer_item_id AND outcome.supplier_id = current_supplier_id
  ) THEN
    RAISE EXCEPTION 'equivalent offer requires an active case and current supplier failure outcome' USING ERRCODE = '42501';
  END IF;

  IF NEW.event_type = 'OFFERED' THEN
    IF offer_state IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer o
      JOIN public.order_item_content_version v ON v.id = o.content_version_id
      JOIN public.order_item_equivalent_offer_route r ON r.offer_id = o.id
      WHERE o.id = NEW.offer_id AND NEW.content_hash = v.content_hash AND NEW.content_hash = r.content_hash)
      OR EXISTS (
        SELECT 1 FROM (
          SELECT DISTINCT ON (e.offer_id) e.offer_id, e.event_type
            FROM public.order_item_equivalent_offer_event e
            JOIN public.order_item_equivalent_offer existing ON existing.id = e.offer_id
           WHERE existing.order_item_id = offer_item_id
           ORDER BY e.offer_id, e.created_at DESC, e.id DESC
        ) latest WHERE latest.event_type = 'OFFERED'
      ) THEN
      RAISE EXCEPTION 'equivalent offer opening is invalid or another offer is unresolved' USING ERRCODE = '23514';
    END IF;
  ELSIF offer_state IS DISTINCT FROM 'OFFERED' THEN
    RAISE EXCEPTION 'equivalent offer already resolved' USING ERRCODE = '23514';
  ELSIF NEW.event_type = 'ACCEPTED' THEN
    IF NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_route r
      WHERE r.offer_id = NEW.offer_id AND r.content_hash = NEW.content_hash)
      OR NEW.notice_version IS NULL THEN
      RAISE EXCEPTION 'equivalent offer consent mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT max(e.created_at) INTO last_item_event FROM public.order_item_equivalent_offer_event e
    JOIN public.order_item_equivalent_offer o ON o.id = e.offer_id WHERE o.order_item_id = offer_item_id;
  NEW.created_at := greatest(coalesce(NEW.created_at, clock_timestamp()),
    coalesce(last_item_event + interval '1 microsecond', clock_timestamp()));
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_reject_equivalent_offer_event_mutation() FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_apply_equivalent_offer_acceptance(target_offer_id text, target_user_id text, target_org_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_item_id text; v_next_supplier text; v_next_recipient text; v_request_id text; v_version_id text;
  v_content_digest text; v_case_id text; v_current_supplier text; v_last_offer text;
  v_route_generation integer; v_target_generation integer; v_latest_accepted_at timestamptz; v_offer_accepted_at timestamptz;
  v_fulfillment public.order_item_fulfillment%ROWTYPE; v_recovery boolean;
BEGIN
  IF target_user_id IS NULL OR target_user_id <> nullif(current_setting('app.user_id',true),'')
    OR target_org_id <> nullif(current_setting('app.organization_id',true),'') THEN
    RAISE EXCEPTION 'equivalent offer unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT o.order_item_id INTO v_item_id FROM public.order_item_equivalent_offer o
    JOIN public.customer_order_item i ON i.id = o.order_item_id
    JOIN public.customer_order ord ON ord.id = i.order_id
   WHERE o.id = target_offer_id AND ord.organization_id = target_org_id AND ord.actor_user_id = target_user_id
     AND public.gphkm_is_active_org_member(target_org_id, target_user_id);
  IF v_item_id IS NULL THEN RAISE EXCEPTION 'equivalent offer unavailable' USING ERRCODE = '42501'; END IF;

  SELECT f.* INTO v_fulfillment FROM public.order_item_fulfillment f
    WHERE f.order_item_id = v_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'equivalent offer unavailable' USING ERRCODE = '42501'; END IF;
  SELECT fs.supplier_id, fs.route_generation, fs.last_equivalent_offer_id
    INTO v_current_supplier, v_route_generation, v_last_offer
    FROM public.order_item_fulfillment_supplier fs WHERE fs.order_item_id = v_item_id FOR UPDATE;
  IF NOT FOUND OR v_last_offer = target_offer_id THEN
    RAISE EXCEPTION 'equivalent offer is stale or already applied' USING ERRCODE = '42501';
  END IF;

  SELECT max(e.created_at) INTO v_latest_accepted_at
    FROM public.order_item_equivalent_offer_event e
    JOIN public.order_item_equivalent_offer o ON o.id = e.offer_id
   WHERE o.order_item_id = v_item_id AND e.event_type = 'ACCEPTED';
  SELECT e.created_at INTO v_offer_accepted_at FROM public.order_item_equivalent_offer_event e
   WHERE e.offer_id = target_offer_id AND e.event_type = 'ACCEPTED'
     AND e.actor_user_id = target_user_id ORDER BY e.created_at DESC, e.id DESC LIMIT 1;
  IF v_offer_accepted_at IS NULL OR v_offer_accepted_at IS DISTINCT FROM v_latest_accepted_at
    OR EXISTS (
      SELECT 1 FROM (
        SELECT DISTINCT ON (e.offer_id) e.offer_id, e.event_type, e.created_at
          FROM public.order_item_equivalent_offer_event e
          JOIN public.order_item_equivalent_offer o ON o.id = e.offer_id
         WHERE o.order_item_id = v_item_id
         ORDER BY e.offer_id, e.created_at DESC, e.id DESC
      ) latest WHERE latest.event_type = 'OFFERED' AND latest.created_at > v_offer_accepted_at
    ) THEN
    RAISE EXCEPTION 'equivalent offer is not the current resolved customer decision' USING ERRCODE = '42501';
  END IF;

  SELECT o.support_case_id, o.content_request_id, o.content_version_id, r.supplier_id,
    r.recipient_email, r.content_hash, r.route_generation
    INTO v_case_id, v_request_id, v_version_id, v_next_supplier, v_next_recipient, v_content_digest, v_target_generation
    FROM public.order_item_equivalent_offer o
    JOIN public.order_item_equivalent_offer_route r ON r.offer_id = o.id
    JOIN public.customer_order_item i ON i.id = o.order_item_id
    JOIN public.customer_order ord ON ord.id = i.order_id
   WHERE o.id = target_offer_id AND o.order_item_id = v_item_id
     AND ord.organization_id = target_org_id AND ord.actor_user_id = target_user_id
     AND public.gphkm_is_active_org_member(target_org_id, target_user_id)
     AND EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_event e
       WHERE e.offer_id = o.id AND e.event_type = 'ACCEPTED'
         AND e.actor_user_id = target_user_id AND e.content_hash = r.content_hash)
     AND NOT EXISTS (SELECT 1 FROM public.order_item_equivalent_offer_event e
       WHERE e.offer_id = o.id AND e.event_type = 'DECLINED');
  IF NOT FOUND OR v_next_supplier IS NULL OR v_next_supplier = v_current_supplier
    OR v_target_generation <> v_route_generation + 1
    OR NOT EXISTS (SELECT 1 FROM public.order_item_content_change_event e
      WHERE e.request_id = v_request_id AND e.event_type = 'CONSENTED' AND e.version_id = v_version_id
        AND e.content_hash = v_content_digest AND e.actor_user_id = target_user_id)
    OR NOT EXISTS (SELECT 1 FROM public.supplier_contact c
      WHERE c.supplier_id = v_next_supplier AND c.is_primary AND lower(c.email) = lower(v_next_recipient))
    OR NOT EXISTS (SELECT 1 FROM public.support_case c
      JOIN public.supplier_fulfillment_outcome outcome ON outcome.support_case_id = c.id
      WHERE c.id = v_case_id AND EXISTS (SELECT 1 FROM public.customer_order_item item WHERE item.id = v_item_id AND item.order_id = c.order_id) AND c.state NOT IN ('RESOLVED','CLOSED')
        AND outcome.order_item_id = v_item_id AND outcome.supplier_id = v_current_supplier) THEN
    RAISE EXCEPTION 'equivalent offer consent, case, or current supplier failure is unavailable' USING ERRCODE = '42501';
  END IF;

  IF v_fulfillment.state IN ('COMPLETED','CANCELED_REFUNDED','CANCELLATION_REQUESTED') THEN
    RAISE EXCEPTION 'equivalent offer is closed for this order item' USING ERRCODE = '42501';
  END IF;
  v_recovery := v_fulfillment.handed_off_at IS NOT NULL OR v_fulfillment.work_started_at IS NOT NULL
    OR v_fulfillment.state IN ('IN_FULFILLMENT','PUBLICATION_PENDING','EVIDENCE_REVIEW','HANDOFF_PENDING');
  IF v_recovery AND NOT EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome
      JOIN public.support_case c ON c.id = outcome.support_case_id
      WHERE outcome.order_item_id = v_item_id AND outcome.supplier_id = v_current_supplier
        AND outcome.support_case_id = v_case_id AND c.state NOT IN ('RESOLVED','CLOSED')) THEN
    RAISE EXCEPTION 'post-handoff routing requires a current supplier failure case' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM public.supplier_packet_item pi
    JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = pi.packet_id
    WHERE pi.order_item_id = v_item_id AND attempt.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERY_ISSUE')) THEN
    RAISE EXCEPTION 'reconcile the supplier packet attempt before changing its route' USING ERRCODE = '42501';
  END IF;

  UPDATE public.order_item_fulfillment_supplier SET supplier_id = v_next_supplier,
    route_generation = route_generation + 1, last_equivalent_offer_id = target_offer_id
   WHERE order_item_id = v_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'equivalent offer route is unavailable' USING ERRCODE = '42501'; END IF;
  UPDATE public.order_item_fulfillment SET state = 'READY_FOR_HANDOFF', state_before_hold = NULL,
    customer_status = 'PREPARING', updated_at = clock_timestamp() WHERE order_item_id = v_item_id;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_apply_equivalent_offer_acceptance(text,text,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_apply_equivalent_offer_acceptance(text,text,text) TO gphkm_runtime;--> statement-breakpoint

-- The ordering member's acceptance is the consent authority. A different
-- organization Owner may open the shared Support case without inheriting it.
CREATE OR REPLACE FUNCTION public.gphkm_validate_content_change_event_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  version_row public.order_item_content_version%ROWTYPE;
  request_row public.order_item_content_change_request%ROWTYPE;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
  current_supplier_id text;
  current_generation integer;
  recovery_required boolean;
BEGIN
  IF NEW.event_type IN ('APPROVED','CONSENTED') THEN
    IF NEW.version_id IS NULL THEN RAISE EXCEPTION 'approved content event requires a version' USING ERRCODE = '23514'; END IF;
    SELECT * INTO version_row FROM public.order_item_content_version v
     WHERE v.id = NEW.version_id AND v.request_id = NEW.request_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'content version does not belong to request' USING ERRCODE = '23514'; END IF;
    IF NEW.content_hash IS DISTINCT FROM version_row.content_hash THEN
      RAISE EXCEPTION 'event hash does not match bound content, supplier and recipient' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.event_type <> 'CONSENTED' THEN RETURN NEW; END IF;

  SELECT * INTO request_row FROM public.order_item_content_change_request r WHERE r.id = NEW.request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'content request unavailable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment f
   WHERE f.order_item_id = request_row.order_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '23514'; END IF;
  SELECT route.supplier_id, route.route_generation INTO current_supplier_id, current_generation
    FROM public.order_item_fulfillment_supplier route
   WHERE route.order_item_id = request_row.order_item_id FOR KEY SHARE;

  recovery_required := fulfillment_row.handed_off_at IS NOT NULL OR fulfillment_row.work_started_at IS NOT NULL
    OR fulfillment_row.state IN ('HANDOFF_PENDING','IN_FULFILLMENT','PUBLICATION_PENDING','EVIDENCE_REVIEW','COMPLETED','CANCELED_REFUNDED','CANCELLATION_REQUESTED')
    OR EXISTS (SELECT 1 FROM public.supplier_packet_item pi
      JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = pi.packet_id
      WHERE pi.order_item_id = request_row.order_item_id
        AND attempt.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERED','DELIVERY_ISSUE','MANUAL_SENT'));
  IF recovery_required AND NOT EXISTS (
    SELECT 1 FROM public.order_item_equivalent_offer offer
    JOIN public.order_item_equivalent_offer_route offered_route ON offered_route.offer_id = offer.id
    JOIN public.customer_order_item item ON item.id = offer.order_item_id
    JOIN public.customer_order ord ON ord.id = item.order_id
    JOIN public.support_case c ON c.id = offer.support_case_id
    JOIN public.supplier_fulfillment_outcome outcome ON outcome.support_case_id = c.id
      AND outcome.order_item_id = item.id AND outcome.supplier_id = current_supplier_id
    JOIN public.supplier_contact contact ON contact.supplier_id = offered_route.supplier_id AND contact.is_primary
    JOIN LATERAL (
      SELECT event.event_type, event.actor_user_id, event.content_hash, event.notice_version
        FROM public.order_item_equivalent_offer_event event
       WHERE event.offer_id = offer.id
       ORDER BY event.created_at DESC, event.id DESC LIMIT 1
    ) latest ON latest.event_type = 'ACCEPTED'
    WHERE offer.content_request_id = NEW.request_id AND offer.content_version_id = NEW.version_id
      AND offer.order_item_id = request_row.order_item_id AND offer.support_case_id = c.id
      AND ord.actor_user_id = NEW.actor_user_id
      AND ord.organization_id = nullif(current_setting('app.organization_id', true), '')
      AND public.gphkm_is_active_org_member(ord.organization_id, NEW.actor_user_id)
      AND c.state NOT IN ('RESOLVED','CLOSED')
      AND request_row.target_supplier_id = offered_route.supplier_id
      AND offered_route.supplier_id IS DISTINCT FROM current_supplier_id
      AND offered_route.route_generation = current_generation + 1
      AND offered_route.content_hash = NEW.content_hash
      AND lower(contact.email) = lower(offered_route.recipient_email)
      AND latest.actor_user_id = NEW.actor_user_id
      AND latest.content_hash = NEW.content_hash
      AND latest.notice_version = NEW.notice_version
      AND NEW.notice_version IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.supplier_packet_item pi
        JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = pi.packet_id
        WHERE pi.order_item_id = request_row.order_item_id
          AND attempt.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERY_ISSUE'))
  ) THEN
    RAISE EXCEPTION 'content consent closes after handoff unless bound to the current customer-approved supplier recovery' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_validate_content_change_event_binding() FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_packet_attempt_route_generation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE packet_row public.supplier_packet%ROWTYPE; item_ref text; item_state text; item_route_supplier_id text; item_route_generation integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.type NOT IN ('SEND','EML_EXPORT','PDF_EXPORT','MANUAL_SENT','MANUAL_SEND') THEN RETURN NEW; END IF;
  SELECT p.* INTO packet_row FROM public.supplier_packet p WHERE p.id = NEW.packet_id FOR UPDATE;
  IF NOT FOUND OR packet_row.superseded_at IS NOT NULL OR packet_row.hold_reason IS NOT NULL THEN
    RAISE EXCEPTION 'supplier packet is superseded, held, or unavailable' USING ERRCODE = '42501';
  END IF;

  FOR item_ref IN
    SELECT pi.order_item_id FROM public.supplier_packet_item pi
     WHERE pi.packet_id = NEW.packet_id ORDER BY pi.order_item_id
  LOOP
    SELECT f.state INTO item_state FROM public.order_item_fulfillment f
      WHERE f.order_item_id = item_ref FOR UPDATE;
    IF item_state IN ('CANCELLATION_REQUESTED','CANCELED_REFUNDED') THEN
      RAISE EXCEPTION 'supplier packet item is canceled or awaiting cancellation' USING ERRCODE = '42501';
    END IF;
    SELECT fs.supplier_id, fs.route_generation INTO item_route_supplier_id, item_route_generation
      FROM public.order_item_fulfillment_supplier fs
      WHERE fs.order_item_id = item_ref FOR KEY SHARE;
    IF item_route_supplier_id IS DISTINCT FROM packet_row.supplier_id OR NOT EXISTS (
      SELECT 1 FROM public.supplier_packet_item pi
      JOIN public.supplier_packet packet ON packet.id = pi.packet_id
      JOIN public.supplier_contact contact ON contact.supplier_id = packet.supplier_id AND contact.is_primary
       WHERE pi.packet_id = NEW.packet_id AND pi.order_item_id = item_ref
         AND pi.route_generation = item_route_generation
         AND packet.version = (SELECT max(latest.version)
           FROM public.supplier_packet latest
           JOIN public.supplier_packet_item latest_item ON latest_item.packet_id = latest.id
           WHERE latest_item.order_item_id = item_ref AND latest_item.route_generation = item_route_generation
             AND latest.supplier_id = item_route_supplier_id AND latest.superseded_at IS NULL AND latest.hold_reason IS NULL)
         AND lower(contact.email) = lower(packet.recipient)
    ) THEN
      RAISE EXCEPTION 'supplier packet route, recipient, or active version is stale' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome
      WHERE outcome.order_item_id = item_ref
        AND NOT EXISTS (
          SELECT 1 FROM public.order_item_equivalent_offer offer
          JOIN public.order_item_equivalent_offer_route offer_route ON offer_route.offer_id = offer.id
          JOIN LATERAL (SELECT e.event_type, e.actor_user_id FROM public.order_item_equivalent_offer_event e
            WHERE e.offer_id = offer.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) latest ON true
          WHERE offer.order_item_id = outcome.order_item_id AND offer.support_case_id = outcome.support_case_id
            AND latest.event_type = 'ACCEPTED' AND offer_route.route_generation <= item_route_generation
        )) THEN
      RAISE EXCEPTION 'resolve the current supplier failure before sending or exporting a packet' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.supplier_packet_item pi WHERE pi.packet_id = NEW.packet_id) THEN
    RAISE EXCEPTION 'supplier packet has no items' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_packet_attempt_route_generation_guard() FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_supplier_failure_case_can_close(target_case_id text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT (public.gphkm_support_admin_access(target_case_id, nullif(current_setting('app.user_id', true), ''))
      OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN'))
    AND NOT EXISTS (
    SELECT 1 FROM public.supplier_fulfillment_outcome outcome
    JOIN public.support_case c ON c.id = outcome.support_case_id
    JOIN public.customer_order_item item ON item.id = outcome.order_item_id
    JOIN public.customer_order ord ON ord.id = item.order_id
    JOIN public.order_item_fulfillment fulfillment ON fulfillment.order_item_id = outcome.order_item_id
    WHERE outcome.support_case_id = target_case_id
      AND fulfillment.state <> 'CANCELED_REFUNDED'
      AND NOT EXISTS (
        SELECT 1 FROM public.order_item_fulfillment_supplier current_route
        JOIN public.order_item_equivalent_offer offer
          ON offer.id = current_route.last_equivalent_offer_id
         AND offer.order_item_id = current_route.order_item_id
         AND offer.support_case_id = c.id
        JOIN public.order_item_equivalent_offer_route offer_route
          ON offer_route.offer_id = offer.id
         AND offer_route.supplier_id = current_route.supplier_id
         AND offer_route.route_generation = current_route.route_generation
        JOIN LATERAL (
          SELECT event.event_type, event.actor_user_id
            FROM public.order_item_equivalent_offer_event event
           WHERE event.offer_id = offer.id
           ORDER BY event.created_at DESC, event.id DESC LIMIT 1
        ) latest ON latest.event_type = 'ACCEPTED' AND latest.actor_user_id = ord.actor_user_id
        WHERE current_route.order_item_id = outcome.order_item_id
      )
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_supplier_failure_case_can_close(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_supplier_failure_case_can_close(text) TO gphkm_runtime;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_gate_unresolved_supplier_failure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.supplier_fulfillment_outcome outcome
    JOIN public.support_case c ON c.id = outcome.support_case_id
    JOIN public.customer_order_item item ON item.id = outcome.order_item_id
    JOIN public.customer_order ord ON ord.id = item.order_id
    WHERE outcome.order_item_id = NEW.order_item_id
      AND NOT EXISTS (
        SELECT 1 FROM public.order_item_fulfillment_supplier fs
        JOIN public.order_item_equivalent_offer offer ON offer.order_item_id = fs.order_item_id
        JOIN public.order_item_equivalent_offer_route route ON route.offer_id = offer.id
        JOIN LATERAL (SELECT e.event_type, e.actor_user_id FROM public.order_item_equivalent_offer_event e
          WHERE e.offer_id = offer.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) latest ON true
        WHERE fs.order_item_id = NEW.order_item_id AND offer.support_case_id = c.id
          AND latest.event_type = 'ACCEPTED' AND latest.actor_user_id = ord.actor_user_id
          AND route.route_generation <= fs.route_generation
      )
  ) AND NEW.state NOT IN ('ON_HOLD','CANCELLATION_REQUESTED','CANCELED_REFUNDED')
    AND NOT (OLD.state = 'ON_HOLD' AND NEW.state = OLD.state_before_hold AND OLD.state_before_hold IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome
        JOIN public.support_case c ON c.id = outcome.support_case_id
        JOIN public.order_item_equivalent_offer offer ON offer.support_case_id = c.id
        JOIN public.order_item_equivalent_offer_event event ON event.offer_id = offer.id
        WHERE outcome.order_item_id = NEW.order_item_id AND event.event_type = 'DECLINED')) THEN
    RAISE EXCEPTION 'resolve supplier failure through customer-approved equivalent or item cancellation before handoff' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_gate_unresolved_supplier_failure() FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_guard_supplier_failure_case_close() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE item_ref text;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state OR NEW.state NOT IN ('RESOLVED','CLOSED') THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome WHERE outcome.support_case_id = OLD.id) THEN RETURN NEW; END IF;
  FOR item_ref IN SELECT DISTINCT outcome.order_item_id FROM public.supplier_fulfillment_outcome outcome
    WHERE outcome.support_case_id = OLD.id ORDER BY outcome.order_item_id LOOP
    PERFORM 1 FROM public.order_item_fulfillment fulfillment WHERE fulfillment.order_item_id = item_ref FOR UPDATE;
    PERFORM 1 FROM public.order_item_fulfillment_supplier route WHERE route.order_item_id = item_ref FOR KEY SHARE;
  END LOOP;
  IF NOT public.gphkm_supplier_failure_case_can_close(OLD.id) THEN
    RAISE EXCEPTION 'supplier failure case must remain active until every failed item has an accepted current route or is canceled/refunded' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_guard_supplier_failure_case_close() FROM PUBLIC;--> statement-breakpoint


-- A supplier-failure hold remains pre-handoff eligible for customer cancellation.
ALTER TABLE public.order_item_fulfillment DROP CONSTRAINT order_item_fulfillment_state_before_cancellation_check;--> statement-breakpoint
ALTER TABLE public.order_item_fulfillment ADD CONSTRAINT order_item_fulfillment_state_before_cancellation_check CHECK (
  state_before_cancellation IS NULL OR state_before_cancellation IN ('CONFIRMED','CONTENT_PREPARATION','AWAITING_CUSTOMER_APPROVAL','READY_FOR_HANDOFF','HANDOFF_PENDING','ON_HOLD')
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_customer_can_request_item_cancellation(target_item_id text, target_user_id text, target_org_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_customer_can_read_order_item(target_item_id, target_user_id, target_org_id)
    AND EXISTS (
      SELECT 1 FROM public.customer_order_item i JOIN public.customer_order o ON o.id = i.order_id
      JOIN public.order_item_fulfillment f ON f.order_item_id = i.id
      WHERE i.id = target_item_id AND o.organization_id = target_org_id AND o.checkout_state = 'PAID'
        AND (f.state IN ('CONFIRMED','CONTENT_PREPARATION','AWAITING_CUSTOMER_APPROVAL','READY_FOR_HANDOFF','HANDOFF_PENDING') OR (f.state = 'ON_HOLD' AND f.state_before_hold IN ('CONFIRMED','CONTENT_PREPARATION','AWAITING_CUSTOMER_APPROVAL','READY_FOR_HANDOFF','HANDOFF_PENDING')
          AND EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome
            JOIN public.support_case c ON c.id = outcome.support_case_id
            JOIN public.order_item_fulfillment_supplier route ON route.order_item_id = outcome.order_item_id
            WHERE outcome.order_item_id = i.id AND outcome.supplier_id = route.supplier_id
              AND c.order_id = o.id AND c.state NOT IN ('RESOLVED','CLOSED') AND c.merged_into_case_id IS NULL)))
        AND f.handed_off_at IS NULL AND f.work_started_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.supplier_packet_item pi JOIN public.supplier_packet_attempt a ON a.packet_id = pi.packet_id
      WHERE pi.order_item_id = target_item_id AND a.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERED','DELIVERY_ISSUE','MANUAL_SENT')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.order_item_content_change_request r
      JOIN LATERAL (SELECT e.event_type FROM public.order_item_content_change_event e
        WHERE e.request_id = r.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) latest ON true
      WHERE r.order_item_id = target_item_id AND latest.event_type IN ('REQUESTED','APPROVED')
        AND NOT (r.target_supplier_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.order_item_equivalent_offer offer
          JOIN public.order_item_equivalent_offer_event event ON event.offer_id = offer.id
          WHERE offer.content_request_id = r.id AND event.event_type = 'DECLINED'))
    )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_customer_can_request_item_cancellation(text,text,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_customer_can_request_item_cancellation(text,text,text) TO gphkm_runtime;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_request_order_item_cancellation(
  target_item_id text, request_id text, request_idempotency_key text, request_digest text, request_reason text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  org_id text := nullif(current_setting('app.organization_id', true), '');
  item_order_id text;
  item_actor_id text;
  request_org_id text;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
  prior public.order_item_cancellation_request%ROWTYPE;
  active_request_id text;
BEGIN
  IF actor_id IS NULL OR org_id IS NULL OR request_id IS NULL OR request_id !~ '^[0-9a-f-]{36}$'
    OR request_idempotency_key IS NULL OR length(request_idempotency_key) NOT BETWEEN 16 AND 128
    OR request_digest IS NULL OR request_digest !~ '^[0-9a-f]{64}$'
    OR request_reason IS NULL OR length(trim(request_reason)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'invalid cancellation request' USING ERRCODE = '22023';
  END IF;
  SELECT o.id, o.actor_user_id, o.organization_id INTO item_order_id, item_actor_id, request_org_id
    FROM public.customer_order_item i JOIN public.customer_order o ON o.id = i.order_id
   WHERE i.id = target_item_id AND o.checkout_state = 'PAID';
  IF NOT FOUND OR request_org_id <> org_id OR NOT public.gphkm_is_active_org_member(org_id, actor_id)
    OR (item_actor_id <> actor_id AND NOT public.gphkm_is_active_org_owner(org_id, actor_id)) THEN
    RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment WHERE order_item_id = target_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO prior FROM public.order_item_cancellation_request
   WHERE organization_id = org_id AND requested_by_user_id = actor_id AND idempotency_key = request_idempotency_key;
  IF FOUND THEN
    IF prior.request_hash <> request_digest OR prior.order_item_id <> target_item_id THEN
      RAISE EXCEPTION 'cancellation idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN prior.id;
  END IF;
  IF NOT (fulfillment_row.state IN ('CONFIRMED','CONTENT_PREPARATION','AWAITING_CUSTOMER_APPROVAL','READY_FOR_HANDOFF','HANDOFF_PENDING')
    OR (fulfillment_row.state = 'ON_HOLD' AND fulfillment_row.state_before_hold IN ('CONFIRMED','CONTENT_PREPARATION','AWAITING_CUSTOMER_APPROVAL','READY_FOR_HANDOFF','HANDOFF_PENDING')
      AND EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome
        JOIN public.support_case c ON c.id = outcome.support_case_id
        JOIN public.order_item_fulfillment_supplier route ON route.order_item_id = outcome.order_item_id
        WHERE outcome.order_item_id = target_item_id AND outcome.supplier_id = route.supplier_id
          AND c.order_id = item_order_id AND c.state NOT IN ('RESOLVED','CLOSED') AND c.merged_into_case_id IS NULL)))
    OR fulfillment_row.state = 'CANCELLATION_REQUESTED'
    OR fulfillment_row.handed_off_at IS NOT NULL OR fulfillment_row.work_started_at IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM public.supplier_packet_item pi JOIN public.supplier_packet_attempt a ON a.packet_id = pi.packet_id
       WHERE pi.order_item_id = target_item_id AND a.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERED','DELIVERY_ISSUE','MANUAL_SENT')
    ) THEN
    RAISE EXCEPTION 'ordinary cancellation is unavailable after handoff or work start' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO active_request_id FROM public.order_item_cancellation_request
   WHERE order_item_id = target_item_id AND state = 'REQUESTED' FOR UPDATE;
  IF FOUND THEN RAISE EXCEPTION 'cancellation request already pending' USING ERRCODE = '23505'; END IF;
  INSERT INTO public.order_item_cancellation_request(
    id, organization_id, order_id, order_item_id, requested_by_user_id, reason, idempotency_key, request_hash
  ) VALUES (request_id, org_id, item_order_id, target_item_id, actor_id, trim(request_reason), request_idempotency_key, request_digest);
  UPDATE public.order_item_fulfillment SET state_before_cancellation = state, state = 'CANCELLATION_REQUESTED', updated_at = now()
   WHERE order_item_id = target_item_id;
  RETURN request_id;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_request_order_item_cancellation(text,text,text,text,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_request_order_item_cancellation(text,text,text,text,text) TO gphkm_runtime;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_decide_order_item_cancellation(
  target_request_id text, target_decision text, target_decision_reason text
) RETURNS TABLE(request_id text, outcome text, amount_minor numeric, ledger_id text, organization_id text, order_item_id text, applied boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  request_row public.order_item_cancellation_request%ROWTYPE;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
  item_row public.customer_order_item%ROWTYPE;
  order_row public.customer_order%ROWTYPE;
  writing_row public.order_item_writing%ROWTYPE;
  refund_value numeric(20,0);
  writing_refund numeric(20,0) := 0;
  ledger_entry_id text;
  previous_state text;
BEGIN
  IF actor_id IS NULL OR target_request_id IS NULL OR target_request_id !~ '^[0-9a-f-]{36}$'
    OR target_decision IS NULL OR target_decision NOT IN ('APPROVED','DENIED')
    OR target_decision_reason IS NULL OR length(trim(target_decision_reason)) NOT BETWEEN 5 AND 1000
    OR NOT (public.gphkm_is_active_staff(actor_id, 'ADMIN') OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')) THEN
    RAISE EXCEPTION 'cancellation decision unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO request_row FROM public.order_item_cancellation_request WHERE id = target_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cancellation request unavailable' USING ERRCODE = '42501'; END IF;
  IF NOT public.gphkm_staff_can_read_order_item(request_row.order_item_id, actor_id) THEN
    RAISE EXCEPTION 'cancellation request unavailable' USING ERRCODE = '42501';
  END IF;
  IF request_row.state <> 'REQUESTED' THEN
    IF request_row.state = target_decision THEN
      RETURN QUERY SELECT request_row.id, request_row.state, request_row.refund_minor, request_row.wallet_ledger_entry_id,
        request_row.organization_id, request_row.order_item_id, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'cancellation request already decided' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment fulfillment WHERE fulfillment.order_item_id = request_row.order_item_id FOR UPDATE;
  SELECT * INTO item_row FROM public.customer_order_item WHERE id = request_row.order_item_id;
  SELECT * INTO order_row FROM public.customer_order WHERE id = request_row.order_id;
  IF NOT FOUND OR order_row.checkout_state <> 'PAID' OR order_row.organization_id <> request_row.organization_id
    OR fulfillment_row.state <> 'CANCELLATION_REQUESTED' OR fulfillment_row.handed_off_at IS NOT NULL
    OR fulfillment_row.work_started_at IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM public.supplier_packet_item pi JOIN public.supplier_packet_attempt a ON a.packet_id = pi.packet_id
       WHERE pi.order_item_id = request_row.order_item_id AND a.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERED','DELIVERY_ISSUE','MANUAL_SENT')
    ) THEN
    RAISE EXCEPTION 'ordinary cancellation cutoff has passed; use support review' USING ERRCODE = '42501';
  END IF;
  IF public.gphkm_is_active_staff(actor_id, 'ADMIN') AND NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')
    AND fulfillment_row.assigned_admin_id IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'assigned Admin required' USING ERRCODE = '42501';
  END IF;
  previous_state := fulfillment_row.state_before_cancellation;
  IF previous_state IS NULL OR previous_state NOT IN ('CONFIRMED','CONTENT_PREPARATION','AWAITING_CUSTOMER_APPROVAL','READY_FOR_HANDOFF','HANDOFF_PENDING','ON_HOLD')
    OR (previous_state = 'ON_HOLD' AND (fulfillment_row.state_before_hold NOT IN ('CONFIRMED','CONTENT_PREPARATION','AWAITING_CUSTOMER_APPROVAL','READY_FOR_HANDOFF','HANDOFF_PENDING')
      OR NOT EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome
        JOIN public.support_case c ON c.id = outcome.support_case_id
        JOIN public.order_item_fulfillment_supplier route ON route.order_item_id = outcome.order_item_id
        WHERE outcome.order_item_id = request_row.order_item_id AND outcome.supplier_id = route.supplier_id
          AND c.order_id = request_row.order_id AND c.state NOT IN ('RESOLVED','CLOSED') AND c.merged_into_case_id IS NULL))) THEN
    RAISE EXCEPTION 'cancellation state cannot be restored safely' USING ERRCODE = '23514';
  END IF;
  IF target_decision = 'DENIED' THEN
    UPDATE public.order_item_fulfillment AS fulfillment SET state = CASE WHEN previous_state = 'ON_HOLD' THEN 'ON_HOLD' ELSE previous_state END, state_before_cancellation = NULL, updated_at = now()
     WHERE fulfillment.order_item_id = request_row.order_item_id;
    UPDATE public.order_item_cancellation_request SET state = 'DENIED', decision_by_user_id = actor_id,
      decision_reason = trim(target_decision_reason), decided_at = now() WHERE id = request_row.id;
    RETURN QUERY SELECT request_row.id, 'DENIED'::text, 0::numeric, NULL::text, request_row.organization_id, request_row.order_item_id, true;
    RETURN;
  END IF;

  refund_value := item_row.placement_price_minor;
  IF item_row.writing_selected THEN
    SELECT * INTO writing_row FROM public.order_item_writing writing WHERE writing.order_item_id = item_row.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'writing stage record unavailable' USING ERRCODE = '23514'; END IF;
    writing_refund := CASE
      WHEN writing_row.state = 'WAITING_FOR_FIRST_DRAFT' THEN item_row.writing_first_stage_minor + item_row.writing_final_stage_minor
      WHEN writing_row.state IN ('FIRST_DRAFT_READY','REVISION_REQUESTED') THEN item_row.writing_final_stage_minor
      ELSE 0
    END;
    refund_value := refund_value + writing_refund;
  END IF;
  IF refund_value <= 0 OR refund_value > item_row.placement_price_minor + item_row.writing_price_minor THEN
    RAISE EXCEPTION 'calculated cancellation refund is invalid' USING ERRCODE = '23514';
  END IF;
  ledger_entry_id := gen_random_uuid()::text;
  INSERT INTO public.wallet_ledger_entry(id, organization_id, actor_user_id, kind, delta_minor, currency,
    operation, idempotency_key, related_type, related_id, reason_code)
  VALUES (ledger_entry_id, request_row.organization_id, actor_id, 'ITEM_REFUND', refund_value, 'USD',
    'ITEM_CANCELLATION_REFUND', request_row.id, 'CUSTOMER_ORDER_ITEM', request_row.order_item_id, 'PRE_HANDOFF_CANCELLATION');
  UPDATE public.order_item_fulfillment AS fulfillment SET state = 'CANCELED_REFUNDED', state_before_cancellation = NULL, state_before_hold = NULL,
    customer_status = 'RESOLVED', updated_at = now() WHERE fulfillment.order_item_id = request_row.order_item_id;
  UPDATE public.order_item_cancellation_request SET state = 'APPROVED', decision_by_user_id = actor_id,
    decision_reason = trim(target_decision_reason), refund_minor = refund_value,
    wallet_ledger_entry_id = ledger_entry_id, decided_at = now() WHERE id = request_row.id;
  RETURN QUERY SELECT request_row.id, 'APPROVED'::text, refund_value, ledger_entry_id,
    request_row.organization_id, request_row.order_item_id, true;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_decide_order_item_cancellation(text,text,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_decide_order_item_cancellation(text,text,text) TO gphkm_runtime;--> statement-breakpoint


-- Refund requests name their target item explicitly; the conversation remains order-scoped.
REVOKE ALL ON FUNCTION public.gphkm_request_post_handoff_refund(text,text,text,text,numeric,text) FROM PUBLIC, gphkm_runtime;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.gphkm_request_post_handoff_refund(
  target_request_id text, target_case_id text, target_order_item_id text, target_idempotency_key text,
  target_request_hash text, target_amount numeric, target_reason text
) RETURNS TABLE(request_id text, state text, requested_amount_minor numeric, organization_id text, order_item_id text, applied boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  case_row public.support_case%ROWTYPE;
  order_row public.customer_order%ROWTYPE;
  item_row public.customer_order_item%ROWTYPE;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
  existing public.post_handoff_refund_request%ROWTYPE;
  next_number integer;
  captured numeric(20,0);
  refunded numeric(20,0);
  request_id_value text;
BEGIN
  IF actor_id IS NULL OR target_request_id !~ '^[0-9a-f-]{36}$' OR target_case_id !~ '^[0-9a-f-]{36}$' OR target_order_item_id !~ '^[0-9a-f-]{36}$'
    OR target_idempotency_key IS NULL OR length(target_idempotency_key) NOT BETWEEN 16 AND 128
    OR target_request_hash IS NULL OR target_request_hash !~ '^[0-9a-f]{64}$'
    OR target_amount IS NULL OR target_amount <= 0
    OR target_reason IS NULL OR length(btrim(target_reason)) NOT BETWEEN 5 AND 2000
    OR NOT (public.gphkm_is_active_staff(actor_id, 'ADMIN') OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')) THEN
    RAISE EXCEPTION 'post-handoff refund request unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO case_row FROM public.support_case WHERE id = target_case_id FOR UPDATE;
  IF NOT FOUND OR case_row.order_id IS NULL OR case_row.merged_into_case_id IS NOT NULL THEN RAISE EXCEPTION 'case unavailable' USING ERRCODE = '23514'; END IF;
  IF public.gphkm_is_active_staff(actor_id, 'ADMIN') AND NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')
     AND NOT public.gphkm_support_admin_access(case_row.id, actor_id) THEN
    RAISE EXCEPTION 'assigned Admin required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO order_row FROM public.customer_order WHERE id = case_row.order_id AND checkout_state = 'PAID';
  SELECT * INTO item_row FROM public.customer_order_item WHERE id = target_order_item_id AND order_id = case_row.order_id;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment fulfillment WHERE fulfillment.order_item_id = target_order_item_id FOR UPDATE;
  IF order_row.id IS NULL OR item_row.id IS NULL OR fulfillment_row.order_item_id IS NULL
    OR order_row.organization_id <> case_row.organization_id THEN
    RAISE EXCEPTION 'item is not available for this Support order' USING ERRCODE = '23514';
  END IF;
  IF public.gphkm_is_active_staff(actor_id, 'ADMIN') AND NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')
    AND fulfillment_row.assigned_admin_id IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'assigned Admin required for this item' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO existing FROM public.post_handoff_refund_request existing_request
   WHERE existing_request.organization_id = case_row.organization_id AND existing_request.requested_by_user_id = actor_id
     AND existing_request.request_idempotency_key = target_idempotency_key;
  IF FOUND THEN
    IF existing.request_hash <> target_request_hash OR existing.case_id <> case_row.id OR existing.order_item_id <> target_order_item_id THEN
      RAISE EXCEPTION 'refund request idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing.id, existing.state, existing.requested_amount_minor, existing.organization_id, existing.order_item_id, false;
    RETURN;
  END IF;
  IF case_row.state <> 'FINANCE_REVIEW' THEN
    RAISE EXCEPTION 'case must be in Finance Review' USING ERRCODE = '23514';
  END IF;
  IF order_row.id IS NULL OR item_row.id IS NULL OR fulfillment_row.order_item_id IS NULL
    OR order_row.organization_id <> case_row.organization_id
    OR (fulfillment_row.handed_off_at IS NULL AND fulfillment_row.work_started_at IS NULL)
    OR fulfillment_row.state IN ('COMPLETED', 'CANCELED_REFUNDED') THEN
    RAISE EXCEPTION 'item is not eligible for a post-handoff exception' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.wallet_account wallet WHERE wallet.organization_id = case_row.organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet unavailable' USING ERRCODE = '23514'; END IF;
  captured := item_row.placement_price_minor + item_row.writing_price_minor;
  IF item_row.writing_selected THEN
    IF NOT EXISTS (SELECT 1 FROM public.order_item_writing w WHERE w.order_item_id = item_row.id AND w.state IN ('APPROVED_FIRST','APPROVED_FINAL')) THEN
      RAISE EXCEPTION 'writing service is not complete' USING ERRCODE = '23514';
    END IF;
    captured := item_row.placement_price_minor;
  END IF;
  SELECT coalesce(sum(ledger.delta_minor), 0) INTO refunded FROM public.wallet_ledger_entry ledger
   WHERE ledger.organization_id = case_row.organization_id AND ledger.kind = 'ITEM_REFUND'
     AND ledger.related_type = 'CUSTOMER_ORDER_ITEM' AND ledger.related_id = target_order_item_id;
  IF target_amount > captured - refunded THEN
    RAISE EXCEPTION 'requested refund exceeds remaining item charge' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(max(request_number), 0) + 1 INTO next_number FROM public.post_handoff_refund_request WHERE case_id = case_row.id;
  INSERT INTO public.post_handoff_refund_request(id, organization_id, case_id, order_id, order_item_id, request_number,
    requested_by_user_id, requested_amount_minor, request_reason, request_idempotency_key, request_hash)
  VALUES (target_request_id, case_row.organization_id, case_row.id, case_row.order_id, target_order_item_id, next_number,
    actor_id, target_amount, btrim(target_reason), target_idempotency_key, target_request_hash);
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
  VALUES (gen_random_uuid()::text, case_row.organization_id, actor_id, 'POST_HANDOFF_REFUND_REQUESTED',
    'SUPPORT_CASE', case_row.id, 'POST_HANDOFF_EXCEPTION', jsonb_build_object('result', 'REQUESTED', 'amountMinor', target_amount::text));
  RETURN QUERY SELECT target_request_id, 'REQUESTED'::text, target_amount, case_row.organization_id, target_order_item_id, true;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_request_post_handoff_refund(text,text,text,text,text,numeric,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_request_post_handoff_refund(text,text,text,text,text,numeric,text) TO gphkm_runtime;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_decide_post_handoff_refund(
  target_request_id text, target_decision text, target_amount numeric, target_reason text,
  target_decision_idempotency_key text, target_decision_hash text
) RETURNS TABLE(request_id text, outcome text, amount_minor numeric, ledger_id text, organization_id text, case_id text, order_item_id text, applied boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  request_row public.post_handoff_refund_request%ROWTYPE;
  case_row public.support_case%ROWTYPE;
  item_row public.customer_order_item%ROWTYPE;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
  wallet_id text;
  ledger_entry_id text;
  captured numeric(20,0);
  refunded numeric(20,0);
  approved_amount numeric(20,0) := 0;
  event_id text;
  state_event_id text;
  result_hash text;
  replay boolean := false;
BEGIN
  IF actor_id IS NULL OR target_request_id !~ '^[0-9a-f-]{36}$'
    OR target_decision NOT IN ('APPROVED', 'DENIED')
    OR target_amount IS NULL OR target_amount < 0
    OR target_reason IS NULL OR length(btrim(target_reason)) NOT BETWEEN 5 AND 1000
    OR target_decision_idempotency_key IS NULL OR length(target_decision_idempotency_key) NOT BETWEEN 16 AND 128
    OR target_decision_hash IS NULL OR target_decision_hash !~ '^[0-9a-f]{64}$'
    OR NOT (public.gphkm_is_active_staff(actor_id, 'FINANCE') OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')) THEN
    RAISE EXCEPTION 'post-handoff refund decision unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO request_row FROM public.post_handoff_refund_request WHERE id = target_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'refund request unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO case_row FROM public.support_case WHERE id = coalesce(
    (SELECT merged_into_case_id FROM public.support_case WHERE id = request_row.case_id), request_row.case_id
  ) FOR UPDATE;
  IF NOT FOUND OR case_row.organization_id <> request_row.organization_id OR case_row.order_id <> request_row.order_id THEN
    RAISE EXCEPTION 'case unavailable' USING ERRCODE = '23514';
  END IF;
  IF request_row.state <> 'REQUESTED' THEN
    IF request_row.decision_idempotency_key = target_decision_idempotency_key
      AND request_row.decision_hash = target_decision_hash THEN
      RETURN QUERY SELECT request_row.id, request_row.state, request_row.refund_minor, request_row.wallet_ledger_entry_id,
        request_row.organization_id, case_row.id, request_row.order_item_id, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'refund request already decided' USING ERRCODE = '23514';
  END IF;
  IF case_row.state <> 'FINANCE_REVIEW' THEN
    RAISE EXCEPTION 'case is not in Finance Review' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO item_row FROM public.customer_order_item WHERE id = request_row.order_item_id AND order_id = request_row.order_id;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment fulfillment WHERE fulfillment.order_item_id = request_row.order_item_id FOR UPDATE;
  IF item_row.id IS NULL OR fulfillment_row.order_item_id IS NULL
    OR (fulfillment_row.handed_off_at IS NULL AND fulfillment_row.work_started_at IS NULL)
    OR fulfillment_row.state IN ('COMPLETED', 'CANCELED_REFUNDED') THEN
    RAISE EXCEPTION 'item is not eligible for a post-handoff exception' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.wallet_account wallet WHERE wallet.organization_id = request_row.organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet unavailable' USING ERRCODE = '23514'; END IF;
  captured := item_row.placement_price_minor + item_row.writing_price_minor;
  IF item_row.writing_selected THEN
    IF NOT EXISTS (SELECT 1 FROM public.order_item_writing w WHERE w.order_item_id = item_row.id AND w.state IN ('APPROVED_FIRST','APPROVED_FINAL')) THEN
      RAISE EXCEPTION 'writing service is not complete' USING ERRCODE = '23514';
    END IF;
    captured := item_row.placement_price_minor;
  END IF;
  SELECT coalesce(sum(ledger.delta_minor), 0) INTO refunded FROM public.wallet_ledger_entry ledger
   WHERE ledger.organization_id = request_row.organization_id AND ledger.kind = 'ITEM_REFUND'
     AND ledger.related_type = 'CUSTOMER_ORDER_ITEM' AND ledger.related_id = request_row.order_item_id;
  IF target_decision = 'APPROVED' THEN
    IF target_amount <= 0 OR target_amount > request_row.requested_amount_minor OR target_amount > captured - refunded THEN
      RAISE EXCEPTION 'approved amount exceeds requested amount or remaining item charge' USING ERRCODE = '23514';
    END IF;
    approved_amount := target_amount;
    ledger_entry_id := gen_random_uuid()::text;
    INSERT INTO public.wallet_ledger_entry(id, organization_id, actor_user_id, kind, delta_minor, currency, operation,
      idempotency_key, related_type, related_id, reason_code)
    VALUES (ledger_entry_id, request_row.organization_id, actor_id, 'ITEM_REFUND', approved_amount, 'USD',
      'POST_HANDOFF_CASE_REFUND', request_row.id, 'CUSTOMER_ORDER_ITEM', request_row.order_item_id, 'SUPPORT_EXCEPTION');
  ELSIF target_amount <> 0 THEN
    RAISE EXCEPTION 'denied decision cannot include a refund amount' USING ERRCODE = '22023';
  END IF;
  result_hash := target_decision_hash;
  UPDATE public.post_handoff_refund_request SET state = target_decision, decision_by_user_id = actor_id,
    decision_reason = btrim(target_reason), refund_minor = approved_amount, wallet_ledger_entry_id = ledger_entry_id,
    decision_idempotency_key = target_decision_idempotency_key, decision_hash = result_hash, decided_at = clock_timestamp()
   WHERE id = request_row.id;
  event_id := gen_random_uuid()::text;
  INSERT INTO public.support_case_event(id, case_id, actor_user_id, actor_kind, kind, audience, body, decision,
    idempotency_key, request_hash)
  VALUES (event_id, case_row.id, actor_id, 'STAFF', 'FINANCE_DECISION', 'FINANCE', btrim(target_reason), target_decision,
    target_decision_idempotency_key, target_decision_hash);
  state_event_id := gen_random_uuid()::text;
  INSERT INTO public.support_case_event(id, case_id, actor_user_id, actor_kind, kind, audience, body, from_state, to_state,
    idempotency_key, request_hash)
  VALUES (state_event_id, case_row.id, actor_id, 'STAFF', 'STATE_CHANGED', 'FINANCE',
    'Finance decision recorded and returned to assigned Admin.', 'FINANCE_REVIEW', 'INVESTIGATING',
    gen_random_uuid()::text, target_decision_hash);
  UPDATE public.support_case SET state = 'INVESTIGATING', updated_at = clock_timestamp() WHERE id = case_row.id;
  IF target_decision = 'APPROVED' THEN
    UPDATE public.order_item_fulfillment AS fulfillment SET state = 'CANCELED_REFUNDED', state_before_cancellation = NULL,
      customer_status = 'RESOLVED', updated_at = clock_timestamp()
     WHERE fulfillment.order_item_id = request_row.order_item_id;
    INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, request_row.organization_id, actor_id, 'FULFILLMENT_STATE_CHANGED',
      'CUSTOMER_ORDER_ITEM', request_row.order_item_id, 'POST_HANDOFF_REFUND',
      jsonb_build_object('fromState', fulfillment_row.state, 'toState', 'CANCELED_REFUNDED', 'result', 'CANCELED'));
  END IF;
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
  VALUES (gen_random_uuid()::text, request_row.organization_id, actor_id, 'POST_HANDOFF_REFUND_DECIDED',
    'POST_HANDOFF_REFUND_REQUEST', request_row.id, target_decision,
    jsonb_build_object('result', target_decision, 'amountMinor', approved_amount::text));
  RETURN QUERY SELECT request_row.id, target_decision, approved_amount, ledger_entry_id,
    request_row.organization_id, case_row.id, request_row.order_item_id, true;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_decide_post_handoff_refund(text,text,numeric,text,text,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_decide_post_handoff_refund(text,text,numeric,text,text,text) TO gphkm_runtime;--> statement-breakpoint
