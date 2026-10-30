CREATE TABLE supplier_listing_cost_event (
  id text PRIMARY KEY,
  listing_id text NOT NULL REFERENCES marketplace_listing(id),
  supplier_id text REFERENCES supplier(id),
  previous_cost_minor numeric(20,0),
  new_cost_minor numeric(20,0),
  reason text NOT NULL,
  actor_user_id text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_listing_cost_event_values CHECK (
    (previous_cost_minor IS NULL OR previous_cost_minor >= 0) AND
    (new_cost_minor IS NULL OR new_cost_minor >= 0) AND
    previous_cost_minor IS DISTINCT FROM new_cost_minor
  ),
  CONSTRAINT supplier_listing_cost_event_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 1000)
);
CREATE INDEX supplier_listing_cost_event_listing_created_idx ON supplier_listing_cost_event(listing_id, created_at DESC);

CREATE TABLE supplier_order_item_cost_event (
  id text PRIMARY KEY,
  order_item_id text NOT NULL REFERENCES customer_order_item(id),
  supplier_id text REFERENCES supplier(id),
  component text NOT NULL CHECK (component IN ('PLACEMENT', 'WRITING')),
  previous_cost_minor numeric(20,0),
  new_cost_minor numeric(20,0) NOT NULL,
  reason text NOT NULL,
  actor_user_id text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_order_cost_event_values CHECK (
    new_cost_minor >= 0 AND (previous_cost_minor IS NULL OR previous_cost_minor >= 0) AND
    previous_cost_minor IS DISTINCT FROM new_cost_minor
  ),
  CONSTRAINT supplier_order_cost_event_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 1000)
);
CREATE INDEX supplier_order_cost_event_item_component_created_idx
  ON supplier_order_item_cost_event(order_item_id, component, created_at DESC);

CREATE TABLE supplier_payment_record (
  id text PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES supplier(id),
  order_item_id text NOT NULL REFERENCES customer_order_item(id),
  amount_minor numeric(20,0) NOT NULL CHECK (amount_minor > 0),
  payment_date timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('PAID', 'UNPAID')),
  evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 1 AND 500),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  actor_user_id text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_payment_supplier_created_idx ON supplier_payment_record(supplier_id, created_at DESC);
CREATE INDEX supplier_payment_item_created_idx ON supplier_payment_record(order_item_id, created_at DESC);

-- Finance can resolve a supplier's display name without gaining access to contacts or notes.
CREATE FUNCTION public.gphkm_finance_supplier_name(target_supplier_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.name FROM public.supplier s
   WHERE s.id = target_supplier_id
     AND (public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE')
       OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN'))
$$;
REVOKE ALL ON FUNCTION public.gphkm_finance_supplier_name(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_finance_supplier_name(text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_supplier_finance_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'supplier finance history is append-only';
END
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_finance_append_only() FROM PUBLIC;
CREATE TRIGGER supplier_listing_cost_event_immutable BEFORE UPDATE OR DELETE ON supplier_listing_cost_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_finance_append_only();
CREATE TRIGGER supplier_order_item_cost_event_immutable BEFORE UPDATE OR DELETE ON supplier_order_item_cost_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_finance_append_only();
CREATE TRIGGER supplier_payment_record_immutable BEFORE UPDATE OR DELETE ON supplier_payment_record
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_finance_append_only();

CREATE FUNCTION public.gphkm_require_supplier_finance_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE expected_action text; expected_type text;
BEGIN
  expected_action := CASE TG_TABLE_NAME
    WHEN 'supplier_listing_cost_event' THEN 'SUPPLIER_LISTING_COST_CORRECTED'
    WHEN 'supplier_order_item_cost_event' THEN 'SUPPLIER_ORDER_COST_CORRECTED'
    WHEN 'supplier_payment_record' THEN 'SUPPLIER_PAYMENT_STATUS_RECORDED'
  END;
  expected_type := TG_TABLE_NAME;
  IF NOT EXISTS (
    SELECT 1 FROM public.audit_event a
     WHERE a.actor_user_id = NEW.actor_user_id
       AND a.action = expected_action
       AND a.target_type = expected_type
       AND a.target_id = NEW.id
  ) OR NEW.actor_user_id <> nullif(current_setting('app.user_id', true), '') THEN
    RAISE EXCEPTION 'supplier finance records require matching actor audit evidence';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.gphkm_require_supplier_finance_audit() FROM PUBLIC;
CREATE TRIGGER supplier_listing_cost_event_audited BEFORE INSERT ON supplier_listing_cost_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_require_supplier_finance_audit();
CREATE TRIGGER supplier_order_item_cost_event_audited BEFORE INSERT ON supplier_order_item_cost_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_require_supplier_finance_audit();
CREATE TRIGGER supplier_payment_record_audited BEFORE INSERT ON supplier_payment_record
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_require_supplier_finance_audit();

CREATE FUNCTION public.gphkm_require_listing_cost_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE event_id text; prior_cost numeric(20,0);
BEGIN
  event_id := nullif(current_setting('app.supplier_cost_event_id', true), '');
  prior_cost := CASE WHEN TG_OP = 'UPDATE' THEN OLD.source_cost_cents ELSE NULL END;
  IF event_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.supplier_listing_cost_event e
    JOIN public.audit_event a ON a.target_id = e.id
       AND a.target_type = 'supplier_listing_cost_event'
       AND a.action = 'SUPPLIER_LISTING_COST_CORRECTED'
       AND a.actor_user_id = e.actor_user_id
     WHERE e.id = event_id AND e.listing_id = NEW.listing_id
       AND e.previous_cost_minor IS NOT DISTINCT FROM prior_cost
       AND e.new_cost_minor IS NOT DISTINCT FROM NEW.source_cost_cents
       AND e.actor_user_id = nullif(current_setting('app.user_id', true), '')
  ) THEN
    RAISE EXCEPTION 'listing cost changes require an audited correction event';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.gphkm_require_listing_cost_event() FROM PUBLIC;
CREATE TRIGGER marketplace_listing_cost_audited BEFORE INSERT OR UPDATE ON marketplace_listing_cost
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_require_listing_cost_event();

ALTER TABLE supplier_listing_cost_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_order_item_cost_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_payment_record ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON supplier_listing_cost_event, supplier_order_item_cost_event, supplier_payment_record TO gphkm_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON supplier_listing_cost_event, supplier_order_item_cost_event, supplier_payment_record FROM gphkm_runtime;

CREATE POLICY supplier_listing_cost_event_finance_read ON supplier_listing_cost_event FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
CREATE POLICY supplier_listing_cost_event_finance_insert ON supplier_listing_cost_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id', true), '') AND (
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
  )
);
CREATE POLICY supplier_order_cost_event_finance_read ON supplier_order_item_cost_event FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
CREATE POLICY supplier_order_cost_event_finance_insert ON supplier_order_item_cost_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id', true), '') AND (
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
  )
);
CREATE POLICY supplier_payment_finance_read ON supplier_payment_record FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
CREATE POLICY supplier_payment_finance_insert ON supplier_payment_record FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id', true), '') AND (
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
  )
);
