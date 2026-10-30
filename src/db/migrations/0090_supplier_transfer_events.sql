-- Replace ambiguous PAID/UNPAID status rows with actual manual transfer facts.
-- Existing status rows remain queryable as legacy history and are never used
-- when calculating payable coverage.
DROP POLICY supplier_payment_finance_insert ON public.supplier_payment_record;
REVOKE INSERT ON public.supplier_payment_record FROM gphkm_runtime;

CREATE TABLE public.supplier_transfer_event (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  supplier_id text NOT NULL REFERENCES public.supplier(id),
  order_item_id text NOT NULL REFERENCES public.customer_order_item(id),
  amount_minor numeric(20,0) NOT NULL CHECK (amount_minor > 0),
  transfer_date timestamptz NOT NULL,
  transfer_reference text NOT NULL CHECK (length(btrim(transfer_reference)) BETWEEN 1 AND 200),
  evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 1 AND 500),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  actor_user_id text NOT NULL REFERENCES public.auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_transfer_idempotency_valid CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  CONSTRAINT supplier_transfer_actor_idempotency_uq UNIQUE (actor_user_id, idempotency_key)
);

CREATE UNIQUE INDEX supplier_transfer_supplier_reference_uq
  ON public.supplier_transfer_event (supplier_id, lower(btrim(transfer_reference)));
CREATE INDEX supplier_transfer_supplier_created_idx
  ON public.supplier_transfer_event (supplier_id, created_at DESC);
CREATE INDEX supplier_transfer_item_created_idx
  ON public.supplier_transfer_event (order_item_id, created_at DESC);

CREATE FUNCTION public.gphkm_supplier_transfer_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.actor_user_id <> nullif(current_setting('app.user_id', true), '')
     OR NOT EXISTS (
       SELECT 1 FROM public.order_item_financial f
        WHERE f.order_item_id = NEW.order_item_id
          AND NEW.supplier_id IN (f.supplier_id, f.fulfillment_supplier_id)
     ) THEN
    RAISE EXCEPTION 'supplier transfer must match the authenticated actor and an item supplier';
  END IF;
  IF NEW.transfer_date > now() THEN
    RAISE EXCEPTION 'future supplier transfer dates are not permitted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.audit_event a
     WHERE a.actor_user_id = NEW.actor_user_id
       AND a.action = 'SUPPLIER_TRANSFER_RECORDED'
       AND a.target_type = 'supplier_transfer_event'
       AND a.target_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'supplier transfer requires matching audit evidence';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_transfer_guard() FROM PUBLIC;

CREATE TRIGGER supplier_transfer_guard BEFORE INSERT ON public.supplier_transfer_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_transfer_guard();
CREATE TRIGGER supplier_transfer_immutable BEFORE UPDATE OR DELETE ON public.supplier_transfer_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_finance_append_only();

ALTER TABLE public.supplier_transfer_event ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.supplier_transfer_event TO gphkm_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON public.supplier_transfer_event FROM gphkm_runtime;

CREATE POLICY supplier_transfer_finance_read ON public.supplier_transfer_event FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
CREATE POLICY supplier_transfer_finance_insert ON public.supplier_transfer_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id', true), '') AND
  (public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
   public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')) AND
  EXISTS (SELECT 1 FROM public.order_item_financial f
    WHERE f.order_item_id = supplier_transfer_event.order_item_id
      AND supplier_transfer_event.supplier_id IN (f.supplier_id, f.fulfillment_supplier_id))
);
