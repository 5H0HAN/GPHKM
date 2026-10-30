-- A single bank/provider transfer may cover multiple order-item costs.
DROP TRIGGER supplier_transfer_guard ON public.supplier_transfer_event;
DROP POLICY supplier_transfer_finance_insert ON public.supplier_transfer_event;

CREATE TABLE public.supplier_transfer_allocation (
  id text PRIMARY KEY,
  transfer_event_id text NOT NULL REFERENCES public.supplier_transfer_event(id),
  order_item_id text NOT NULL REFERENCES public.customer_order_item(id),
  amount_minor numeric(20,0) NOT NULL CHECK (amount_minor > 0),
  actor_user_id text NOT NULL REFERENCES public.auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_transfer_allocation_item_uq UNIQUE (transfer_event_id, order_item_id)
);
CREATE INDEX supplier_transfer_allocation_item_idx
  ON public.supplier_transfer_allocation(order_item_id, created_at DESC);

-- Preserve any local/early-access single-item transfer rows as a one-item
-- allocation, with linked audit evidence, before removing the old item column.
INSERT INTO public.audit_event(id, actor_user_id, action, target_type, target_id, reason_code, metadata)
SELECT gen_random_uuid()::text, event.actor_user_id, 'SUPPLIER_TRANSFER_ALLOCATED',
       'supplier_transfer_allocation', md5(event.id || ':legacy-allocation'),
       'LEGACY_SINGLE_ITEM_BACKFILL', jsonb_build_object('transferId', event.id, 'orderItemId', event.order_item_id, 'amountMinor', event.amount_minor)
  FROM public.supplier_transfer_event event;
INSERT INTO public.supplier_transfer_allocation(id, transfer_event_id, order_item_id, amount_minor, actor_user_id)
SELECT md5(event.id || ':legacy-allocation'), event.id, event.order_item_id, event.amount_minor, event.actor_user_id
  FROM public.supplier_transfer_event event;

DROP INDEX public.supplier_transfer_item_created_idx;
ALTER TABLE public.supplier_transfer_event DROP COLUMN order_item_id;

CREATE OR REPLACE FUNCTION public.gphkm_supplier_transfer_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.actor_user_id <> nullif(current_setting('app.user_id', true), '')
     OR NEW.transfer_date > now()
     OR NOT EXISTS (
       SELECT 1 FROM public.audit_event a
        WHERE a.actor_user_id = NEW.actor_user_id
          AND a.action = 'SUPPLIER_TRANSFER_RECORDED'
          AND a.target_type = 'supplier_transfer_event'
          AND a.target_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'supplier transfer requires an authenticated actor, nonfuture date, and audit evidence';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER supplier_transfer_guard BEFORE INSERT ON public.supplier_transfer_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_transfer_guard();

CREATE FUNCTION public.gphkm_supplier_transfer_allocation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE transfer_supplier_id text;
BEGIN
  SELECT event.supplier_id INTO transfer_supplier_id
    FROM public.supplier_transfer_event event WHERE event.id = NEW.transfer_event_id;
  IF transfer_supplier_id IS NULL
     OR NEW.actor_user_id <> nullif(current_setting('app.user_id', true), '')
     OR NOT EXISTS (
       SELECT 1 FROM public.order_item_financial f
        WHERE f.order_item_id = NEW.order_item_id
          AND transfer_supplier_id IN (f.supplier_id, f.fulfillment_supplier_id)
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.audit_event a
        WHERE a.actor_user_id = NEW.actor_user_id
          AND a.action = 'SUPPLIER_TRANSFER_ALLOCATED'
          AND a.target_type = 'supplier_transfer_allocation'
          AND a.target_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'supplier transfer allocation must match the transfer supplier and authenticated audit actor';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_transfer_allocation_guard() FROM PUBLIC;
CREATE TRIGGER supplier_transfer_allocation_guard BEFORE INSERT ON public.supplier_transfer_allocation
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_transfer_allocation_guard();
CREATE TRIGGER supplier_transfer_allocation_immutable BEFORE UPDATE OR DELETE ON public.supplier_transfer_allocation
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_finance_append_only();

CREATE FUNCTION public.gphkm_validate_supplier_transfer_allocation_total() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE event_id text; expected_amount numeric(20,0); allocated_amount numeric(20,0); allocation_count integer;
BEGIN
  IF TG_TABLE_NAME = 'supplier_transfer_event' THEN event_id := NEW.id;
  ELSE event_id := NEW.transfer_event_id;
  END IF;
  SELECT event.amount_minor INTO expected_amount FROM public.supplier_transfer_event event WHERE event.id = event_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT coalesce(sum(allocation.amount_minor), 0), count(*)
    INTO allocated_amount, allocation_count
    FROM public.supplier_transfer_allocation allocation WHERE allocation.transfer_event_id = event_id;
  IF allocation_count = 0 OR allocated_amount <> expected_amount THEN
    RAISE EXCEPTION 'supplier transfer allocations must exactly equal the transfer amount'
      USING ERRCODE = '23514', DETAIL = format('transfer %s expects %s minor units across at least one allocation; recorded %s across %s allocation(s)', event_id, expected_amount, allocated_amount, allocation_count);
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.gphkm_validate_supplier_transfer_allocation_total() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER supplier_transfer_event_allocation_total
  AFTER INSERT ON public.supplier_transfer_event DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_validate_supplier_transfer_allocation_total();
CREATE CONSTRAINT TRIGGER supplier_transfer_allocation_total
  AFTER INSERT ON public.supplier_transfer_allocation DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_validate_supplier_transfer_allocation_total();

ALTER TABLE public.supplier_transfer_allocation ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.supplier_transfer_allocation TO gphkm_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON public.supplier_transfer_allocation FROM gphkm_runtime;
CREATE POLICY supplier_transfer_allocation_finance_read ON public.supplier_transfer_allocation FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
CREATE POLICY supplier_transfer_finance_insert ON public.supplier_transfer_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id', true), '') AND
  (public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
   public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN'))
);
CREATE POLICY supplier_transfer_allocation_finance_insert ON public.supplier_transfer_allocation FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id', true), '') AND
  (public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
   public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')) AND
  EXISTS (
    SELECT 1 FROM public.supplier_transfer_event event
    JOIN public.order_item_financial financial ON financial.order_item_id = supplier_transfer_allocation.order_item_id
     WHERE event.id = supplier_transfer_allocation.transfer_event_id
       AND event.supplier_id IN (financial.supplier_id, financial.fulfillment_supplier_id)
  )
);
