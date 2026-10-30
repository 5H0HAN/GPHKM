-- Minimal item-linked Support. This migration is intentionally not journaled/applied here.
CREATE TABLE support_case (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id),
  order_id text NOT NULL REFERENCES customer_order(id),
  order_item_id text NOT NULL REFERENCES customer_order_item(id),
  opened_by_user_id text NOT NULL REFERENCES auth_user(id),
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 2000),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','INVESTIGATING','WAITING_ON_CUSTOMER','WAITING_ON_SUPPLIER','FINANCE_REVIEW','RESOLVED','CLOSED')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_case_open_idem_uq UNIQUE (organization_id, opened_by_user_id, idempotency_key)
);
CREATE INDEX support_case_org_updated_idx ON support_case(organization_id, updated_at);
CREATE INDEX support_case_item_idx ON support_case(order_item_id);
ALTER TABLE support_case ENABLE ROW LEVEL SECURITY;

CREATE TABLE support_case_event (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES support_case(id),
  actor_user_id text NOT NULL REFERENCES auth_user(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('CUSTOMER','STAFF')),
  kind text NOT NULL CHECK (kind IN ('OPENED','REPLY','NOTE','STATE_CHANGED','FINANCE_DECISION')),
  audience text NOT NULL CHECK (audience IN ('CUSTOMER','INTERNAL','FINANCE')),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  from_state text,
  to_state text,
  decision text CHECK (decision IN ('DENIED','MORE_INFORMATION_REQUIRED')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_case_event_idem_uq UNIQUE (case_id, actor_user_id, idempotency_key),
  CONSTRAINT support_case_event_shape CHECK (
    (kind = 'OPENED' AND audience = 'INTERNAL' AND actor_kind = 'CUSTOMER' AND from_state IS NULL AND to_state = 'OPEN' AND decision IS NULL)
    OR (kind = 'REPLY' AND audience = 'CUSTOMER' AND from_state IS NULL AND to_state IS NULL AND decision IS NULL)
    OR (kind = 'NOTE' AND audience IN ('INTERNAL','FINANCE') AND actor_kind = 'STAFF' AND from_state IS NULL AND to_state IS NULL AND decision IS NULL)
    OR (kind = 'STATE_CHANGED' AND audience IN ('INTERNAL','FINANCE') AND actor_kind = 'STAFF' AND from_state IS NOT NULL AND to_state IS NOT NULL AND decision IS NULL)
    OR (kind = 'FINANCE_DECISION' AND audience = 'FINANCE' AND actor_kind = 'STAFF' AND from_state IS NULL AND to_state IS NULL AND decision IS NOT NULL)
  )
);
CREATE INDEX support_case_event_history_idx ON support_case_event(case_id, created_at);
ALTER TABLE support_case_event ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.gphkm_support_customer_access(target_case text, target_user text, target_org text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.support_case c JOIN public.customer_order o ON o.id = c.order_id
    WHERE c.id = target_case AND c.organization_id = target_org
      AND public.gphkm_is_active_org_member(c.organization_id, target_user)
      AND (public.gphkm_is_active_org_owner(c.organization_id, target_user)
        OR c.opened_by_user_id = target_user OR o.actor_user_id = target_user)
  )
$$;
CREATE FUNCTION public.gphkm_support_admin_access(target_case text, target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_is_active_staff(target_user, 'SUPER_ADMIN') OR (
    public.gphkm_is_active_staff(target_user, 'ADMIN') AND EXISTS (
      SELECT 1 FROM public.support_case c JOIN public.order_item_fulfillment f ON f.order_item_id = c.order_item_id
      WHERE c.id = target_case AND f.assigned_admin_id = target_user
    )
  )
$$;
CREATE FUNCTION public.gphkm_support_finance_access(target_case text, target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_is_active_staff(target_user, 'FINANCE') AND EXISTS (
    SELECT 1 FROM public.support_case c WHERE c.id = target_case AND c.state = 'FINANCE_REVIEW'
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_support_customer_access(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gphkm_support_admin_access(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gphkm_support_finance_access(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_support_customer_access(text,text,text), public.gphkm_support_admin_access(text,text), public.gphkm_support_finance_access(text,text) TO gphkm_runtime;

-- Customers may append replies without receiving general UPDATE authority.
CREATE FUNCTION public.gphkm_lock_support_case(target_case text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id',true),'');
BEGIN
  IF NOT (public.gphkm_support_customer_access(target_case,actor_id,nullif(current_setting('app.organization_id',true),''))
    OR public.gphkm_support_admin_access(target_case,actor_id) OR public.gphkm_support_finance_access(target_case,actor_id)) THEN
    RAISE EXCEPTION 'support case unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM id FROM public.support_case WHERE id = target_case FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_lock_support_case(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_lock_support_case(text) TO gphkm_runtime;

CREATE POLICY support_case_customer_read ON support_case FOR SELECT TO gphkm_runtime USING (
  public.gphkm_support_customer_access(id, nullif(current_setting('app.user_id',true),''), nullif(current_setting('app.organization_id',true),''))
);
CREATE POLICY support_case_customer_open ON support_case FOR INSERT TO gphkm_runtime WITH CHECK (
  organization_id = nullif(current_setting('app.organization_id',true),'')
  AND opened_by_user_id = nullif(current_setting('app.user_id',true),'') AND state = 'OPEN'
  AND public.gphkm_customer_can_read_order_item(order_item_id, opened_by_user_id, organization_id)
);
CREATE POLICY support_case_staff_read ON support_case FOR SELECT TO gphkm_runtime USING (
  public.gphkm_support_admin_access(id, nullif(current_setting('app.user_id',true),''))
  OR public.gphkm_support_finance_access(id, nullif(current_setting('app.user_id',true),''))
);
CREATE POLICY support_case_admin_update ON support_case FOR UPDATE TO gphkm_runtime USING (
  public.gphkm_support_admin_access(id, nullif(current_setting('app.user_id',true),''))
) WITH CHECK (public.gphkm_support_admin_access(id, nullif(current_setting('app.user_id',true),'')));
CREATE POLICY support_case_finance_update ON support_case FOR UPDATE TO gphkm_runtime USING (
  public.gphkm_support_finance_access(id, nullif(current_setting('app.user_id',true),''))
) WITH CHECK (state = 'INVESTIGATING' AND public.gphkm_is_active_staff(nullif(current_setting('app.user_id',true),''),'FINANCE'));

CREATE POLICY support_event_customer_read ON support_case_event FOR SELECT TO gphkm_runtime USING (
  audience = 'CUSTOMER' AND kind = 'REPLY' AND public.gphkm_support_customer_access(case_id,
    nullif(current_setting('app.user_id',true),''), nullif(current_setting('app.organization_id',true),''))
);
CREATE POLICY support_event_staff_read ON support_case_event FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id',true),''),'SUPER_ADMIN')
  OR (audience IN ('CUSTOMER','INTERNAL') AND public.gphkm_support_admin_access(case_id,nullif(current_setting('app.user_id',true),'')))
  OR (audience IN ('CUSTOMER','FINANCE') AND public.gphkm_support_finance_access(case_id,nullif(current_setting('app.user_id',true),'')))
);
CREATE POLICY support_event_customer_insert ON support_case_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id',true),'') AND actor_kind = 'CUSTOMER'
  AND ((kind = 'REPLY' AND audience = 'CUSTOMER') OR (kind = 'OPENED' AND audience = 'INTERNAL'))
  AND public.gphkm_support_customer_access(case_id, actor_user_id, nullif(current_setting('app.organization_id',true),''))
);
CREATE POLICY support_event_staff_insert ON support_case_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id',true),'') AND actor_kind = 'STAFF'
  AND (
    (public.gphkm_support_admin_access(case_id,actor_user_id) AND audience IN ('CUSTOMER','INTERNAL') AND kind IN ('REPLY','NOTE','STATE_CHANGED'))
    OR (audience = 'FINANCE' AND kind IN ('NOTE','FINANCE_DECISION','STATE_CHANGED') AND (
      public.gphkm_support_finance_access(case_id,actor_user_id) OR public.gphkm_is_active_staff(actor_user_id,'SUPER_ADMIN')))
  )
);

CREATE FUNCTION public.gphkm_support_case_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actual_org text; actual_order text; actor_id text := nullif(current_setting('app.user_id',true),'');
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT o.organization_id, o.id INTO actual_org, actual_order FROM public.customer_order_item i
      JOIN public.customer_order o ON o.id = i.order_id WHERE i.id = NEW.order_item_id AND o.checkout_state = 'PAID';
    IF NOT FOUND OR actual_org <> NEW.organization_id OR actual_order <> NEW.order_id THEN
      RAISE EXCEPTION 'support order/item mismatch' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.id,NEW.organization_id,NEW.order_id,NEW.order_item_id,NEW.opened_by_user_id,NEW.summary,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
       IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.order_id,OLD.order_item_id,OLD.opened_by_user_id,OLD.summary,OLD.idempotency_key,OLD.request_hash,OLD.created_at) THEN
      RAISE EXCEPTION 'support case identity and opening are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.state <> OLD.state AND NOT (
      (OLD.state = 'OPEN' AND NEW.state IN ('INVESTIGATING','WAITING_ON_CUSTOMER','WAITING_ON_SUPPLIER','FINANCE_REVIEW','RESOLVED','CLOSED'))
      OR (OLD.state = 'INVESTIGATING' AND NEW.state IN ('WAITING_ON_CUSTOMER','WAITING_ON_SUPPLIER','FINANCE_REVIEW','RESOLVED','CLOSED'))
      OR (OLD.state IN ('WAITING_ON_CUSTOMER','WAITING_ON_SUPPLIER') AND NEW.state IN ('INVESTIGATING','FINANCE_REVIEW','RESOLVED','CLOSED'))
      OR (OLD.state = 'FINANCE_REVIEW' AND NEW.state = 'INVESTIGATING')
      OR (OLD.state = 'RESOLVED' AND NEW.state = 'CLOSED')
    ) THEN RAISE EXCEPTION 'invalid support state transition' USING ERRCODE = '23514'; END IF;
    IF NEW.state <> OLD.state AND OLD.state = 'FINANCE_REVIEW' THEN
      IF NEW.state <> 'INVESTIGATING' OR NOT (public.gphkm_is_active_staff(actor_id,'FINANCE') OR public.gphkm_is_active_staff(actor_id,'SUPER_ADMIN'))
        OR NOT EXISTS (SELECT 1 FROM public.support_case_event e WHERE e.case_id = OLD.id AND e.actor_user_id = actor_id
          AND e.kind = 'FINANCE_DECISION' AND e.created_at >= transaction_timestamp()) THEN
        RAISE EXCEPTION 'finance review requires a recorded Finance decision' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF NEW.state <> OLD.state AND NOT EXISTS (SELECT 1 FROM public.support_case_event e
      WHERE e.case_id = OLD.id AND e.actor_user_id = actor_id AND e.kind = 'STATE_CHANGED'
        AND e.from_state = OLD.state AND e.to_state = NEW.state AND e.created_at >= transaction_timestamp()) THEN
      RAISE EXCEPTION 'support state change requires append-only history' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_support_case_guard() FROM PUBLIC;
CREATE TRIGGER support_case_guard BEFORE INSERT OR UPDATE ON support_case FOR EACH ROW EXECUTE FUNCTION public.gphkm_support_case_guard();

CREATE FUNCTION public.gphkm_support_event_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE case_row public.support_case%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'support history is append-only' USING ERRCODE = '23514'; END IF;
  SELECT * INTO case_row FROM public.support_case WHERE id = NEW.case_id FOR UPDATE;
  IF NOT FOUND OR case_row.state = 'CLOSED' THEN RAISE EXCEPTION 'support case is unavailable' USING ERRCODE = '23514'; END IF;
  IF NEW.kind = 'OPENED' AND (NEW.actor_user_id <> case_row.opened_by_user_id OR NEW.body <> case_row.summary
    OR EXISTS (SELECT 1 FROM public.support_case_event WHERE case_id = NEW.case_id AND kind = 'OPENED')) THEN
    RAISE EXCEPTION 'opening event mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'FINANCE_DECISION' AND case_row.state <> 'FINANCE_REVIEW' THEN
    RAISE EXCEPTION 'finance decision requires review' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_support_event_guard() FROM PUBLIC;
CREATE TRIGGER support_event_guard BEFORE INSERT OR UPDATE OR DELETE ON support_case_event FOR EACH ROW EXECUTE FUNCTION public.gphkm_support_event_guard();

CREATE FUNCTION public.gphkm_support_event_touch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.support_case SET updated_at = clock_timestamp() WHERE id = NEW.case_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_support_event_touch() FROM PUBLIC;
CREATE TRIGGER support_event_touch AFTER INSERT ON support_case_event FOR EACH ROW EXECUTE FUNCTION public.gphkm_support_event_touch();

GRANT SELECT, INSERT, UPDATE ON support_case TO gphkm_runtime;
GRANT SELECT, INSERT ON support_case_event TO gphkm_runtime;
REVOKE DELETE ON support_case FROM gphkm_runtime;
REVOKE UPDATE, DELETE ON support_case_event FROM gphkm_runtime;
