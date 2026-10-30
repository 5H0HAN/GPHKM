-- Operational workflow and supplier identity are kept outside the immutable order and finance snapshots.
CREATE TABLE order_item_fulfillment (
  order_item_id text PRIMARY KEY REFERENCES customer_order_item(id),
  order_id text NOT NULL REFERENCES customer_order(id),
  listing_title text NOT NULL CHECK (length(listing_title) BETWEEN 1 AND 120),
  state text NOT NULL DEFAULT 'CONFIRMED' CHECK (state IN (
    'CONFIRMED', 'CONTENT_PREPARATION', 'AWAITING_CUSTOMER_APPROVAL', 'READY_FOR_HANDOFF',
    'HANDOFF_PENDING', 'IN_FULFILLMENT', 'PUBLICATION_PENDING', 'EVIDENCE_REVIEW',
    'COMPLETED', 'ON_HOLD', 'CANCELLATION_REQUESTED', 'CANCELED_REFUNDED'
  )),
  assigned_admin_id text REFERENCES auth_user(id),
  state_before_hold text,
  state_before_cancellation text,
  customer_status text NOT NULL DEFAULT 'ORDER_RECEIVED' CHECK (customer_status IN (
    'ORDER_RECEIVED', 'CONTENT_REVIEW', 'PREPARING', 'IN_PROGRESS', 'LINK_VERIFICATION', 'COMPLETE', 'RESOLVED'
  )),
  next_update_at timestamptz,
  work_started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state_before_hold IS NULL OR state_before_hold IN (
    'CONFIRMED', 'CONTENT_PREPARATION', 'AWAITING_CUSTOMER_APPROVAL', 'READY_FOR_HANDOFF',
    'HANDOFF_PENDING', 'IN_FULFILLMENT', 'PUBLICATION_PENDING', 'EVIDENCE_REVIEW'
  )),
  CHECK (state_before_cancellation IS NULL OR state_before_cancellation IN (
    'CONFIRMED', 'CONTENT_PREPARATION', 'AWAITING_CUSTOMER_APPROVAL', 'READY_FOR_HANDOFF'
  ))
);
CREATE INDEX order_item_fulfillment_assignee_idx ON order_item_fulfillment(assigned_admin_id, state, updated_at);
CREATE INDEX order_item_fulfillment_order_idx ON order_item_fulfillment(order_id);
ALTER TABLE order_item_fulfillment ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON order_item_fulfillment TO gphkm_runtime;
REVOKE INSERT, DELETE ON order_item_fulfillment FROM gphkm_runtime;

CREATE TABLE order_item_fulfillment_supplier (
  order_item_id text PRIMARY KEY REFERENCES order_item_fulfillment(order_item_id),
  supplier_id text REFERENCES supplier(id)
);
ALTER TABLE order_item_fulfillment_supplier ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON order_item_fulfillment_supplier TO gphkm_runtime;
REVOKE INSERT, UPDATE, DELETE ON order_item_fulfillment_supplier FROM gphkm_runtime;

CREATE TABLE publication_evidence (
  id text PRIMARY KEY,
  order_item_id text NOT NULL REFERENCES order_item_fulfillment(order_item_id),
  live_url text NOT NULL CHECK (length(live_url) BETWEEN 8 AND 2048
    AND live_url ~* '^https?://[^/?#[:space:]]+([/?#].*)?$'
    AND live_url !~* '^https?://[^/@?#]+@'
    AND live_url !~ '[[:cntrl:][:space:]]'),
  method text NOT NULL DEFAULT 'STAFF_MANUAL' CHECK (method = 'STAFF_MANUAL'),
  verified_by_user_id text NOT NULL REFERENCES auth_user(id),
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX publication_evidence_item_verified_idx ON publication_evidence(order_item_id, verified_at);
ALTER TABLE publication_evidence ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON publication_evidence TO gphkm_runtime;
REVOKE UPDATE, DELETE ON publication_evidence FROM gphkm_runtime;

-- The immutable finance snapshot is the authoritative order-time source for the fulfillment contact.
CREATE FUNCTION public.gphkm_create_fulfillment_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE order_ref text; item_title text;
BEGIN
  SELECT oi.order_id, oi.customer_listing_snapshot ->> 'title'
    INTO order_ref, item_title
    FROM public.customer_order_item oi WHERE oi.id = NEW.order_item_id;
  IF NOT FOUND OR item_title IS NULL OR length(item_title) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'fulfillment snapshot source unavailable' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.order_item_fulfillment(order_item_id, order_id, listing_title)
    VALUES (NEW.order_item_id, order_ref, item_title);
  INSERT INTO public.order_item_fulfillment_supplier(order_item_id, supplier_id)
    VALUES (NEW.order_item_id, NEW.fulfillment_supplier_id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_create_fulfillment_snapshot() FROM PUBLIC;
CREATE TRIGGER order_item_financial_create_fulfillment
  AFTER INSERT ON order_item_financial FOR EACH ROW
  EXECUTE FUNCTION public.gphkm_create_fulfillment_snapshot();

CREATE FUNCTION public.gphkm_staff_can_read_order_item(target_item_id text, target_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_is_active_staff(target_user_id, 'SUPER_ADMIN') OR EXISTS (
    SELECT 1 FROM public.order_item_fulfillment f
     WHERE f.order_item_id = target_item_id AND f.assigned_admin_id = target_user_id
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_staff_can_read_order_item(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_staff_can_read_order_item(text, text) TO gphkm_runtime;
CREATE FUNCTION public.gphkm_staff_can_read_order(target_order_id text, target_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_is_active_staff(target_user_id, 'SUPER_ADMIN') OR EXISTS (
    SELECT 1 FROM public.order_item_fulfillment f
     WHERE f.order_id = target_order_id AND f.assigned_admin_id = target_user_id
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_staff_can_read_order(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_staff_can_read_order(text, text) TO gphkm_runtime;
CREATE FUNCTION public.gphkm_customer_can_read_order_item(target_item_id text, target_user_id text, target_organization_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.customer_order_item oi JOIN public.customer_order o ON o.id = oi.order_id
     WHERE oi.id = target_item_id AND o.organization_id = target_organization_id
       AND (o.actor_user_id = target_user_id
         OR public.gphkm_is_active_org_owner(o.organization_id, target_user_id))
       AND public.gphkm_is_active_org_member(o.organization_id, target_user_id)
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_customer_can_read_order_item(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_customer_can_read_order_item(text, text, text) TO gphkm_runtime;

CREATE POLICY order_item_fulfillment_staff_read ON order_item_fulfillment FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'ADMIN')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
  OR public.gphkm_customer_can_read_order_item(order_item_id,
    nullif(current_setting('app.user_id', true), ''), nullif(current_setting('app.organization_id', true), ''))
);
CREATE POLICY order_item_fulfillment_staff_update ON order_item_fulfillment FOR UPDATE TO gphkm_runtime
  USING (
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'ADMIN')
    OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
  ) WITH CHECK (
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'ADMIN')
    OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
  );
CREATE POLICY order_item_fulfillment_supplier_assigned_read ON order_item_fulfillment_supplier FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM public.order_item_fulfillment f WHERE f.order_item_id = order_item_fulfillment_supplier.order_item_id
    AND (f.assigned_admin_id = nullif(current_setting('app.user_id', true), '')
      OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')))
);
CREATE POLICY publication_evidence_staff_read ON publication_evidence FOR SELECT TO gphkm_runtime USING (
  public.gphkm_staff_can_read_order_item(order_item_id, nullif(current_setting('app.user_id', true), ''))
);
CREATE POLICY publication_evidence_assigned_insert ON publication_evidence FOR INSERT TO gphkm_runtime WITH CHECK (
  verified_by_user_id = nullif(current_setting('app.user_id', true), '')
  AND EXISTS (SELECT 1 FROM public.order_item_fulfillment f WHERE f.order_item_id = publication_evidence.order_item_id
    AND (f.assigned_admin_id = nullif(current_setting('app.user_id', true), '')
      OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')))
);
CREATE POLICY customer_order_fulfillment_read ON order_item_fulfillment FOR SELECT TO gphkm_runtime USING (
  public.gphkm_customer_can_read_order_item(order_item_id,
    nullif(current_setting('app.user_id', true), ''), nullif(current_setting('app.organization_id', true), ''))
);
CREATE POLICY customer_publication_evidence_read ON publication_evidence FOR SELECT TO gphkm_runtime USING (
  public.gphkm_customer_can_read_order_item(order_item_id,
    nullif(current_setting('app.user_id', true), ''), nullif(current_setting('app.organization_id', true), ''))
);
CREATE POLICY customer_order_staff_assigned_read ON customer_order FOR SELECT TO gphkm_runtime USING (
  public.gphkm_staff_can_read_order(id, nullif(current_setting('app.user_id', true), ''))
);
CREATE POLICY customer_order_item_staff_assigned_read ON customer_order_item FOR SELECT TO gphkm_runtime USING (
  public.gphkm_staff_can_read_order_item(id, nullif(current_setting('app.user_id', true), ''))
);

-- Staff updates are issued only through audited server commands. Customers can only read fulfillment projections.
GRANT SELECT ON order_item_fulfillment, order_item_fulfillment_supplier, publication_evidence TO gphkm_runtime;
REVOKE DELETE ON order_item_fulfillment, order_item_fulfillment_supplier, publication_evidence FROM gphkm_runtime;

-- A privileged application path cannot complete an item without recorded live-link evidence.
CREATE FUNCTION public.gphkm_require_publication_evidence_for_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.state = 'COMPLETED' AND OLD.state IS DISTINCT FROM NEW.state
     AND NOT EXISTS (SELECT 1 FROM public.publication_evidence e WHERE e.order_item_id = NEW.order_item_id) THEN
    RAISE EXCEPTION 'publication evidence is required before completion' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_require_publication_evidence_for_completion() FROM PUBLIC;
CREATE TRIGGER order_item_fulfillment_requires_evidence
  BEFORE UPDATE OF state ON order_item_fulfillment FOR EACH ROW
  EXECUTE FUNCTION public.gphkm_require_publication_evidence_for_completion();
