CREATE TABLE public.customer_order_item_milestone (
  id text PRIMARY KEY,
  order_item_id text NOT NULL REFERENCES public.order_item_fulfillment(order_item_id),
  status text NOT NULL CHECK (status IN ('ORDER_RECEIVED', 'CONTENT_REVIEW', 'PREPARING', 'IN_PROGRESS', 'LINK_VERIFICATION', 'COMPLETE', 'RESOLVED')),
  next_update_at timestamptz,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_order_item_milestone_item_time_idx
  ON public.customer_order_item_milestone(order_item_id, occurred_at, id);
ALTER TABLE public.customer_order_item_milestone ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.customer_order_item_milestone TO gphkm_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.customer_order_item_milestone FROM gphkm_runtime;
CREATE POLICY customer_milestone_customer_read ON public.customer_order_item_milestone
  FOR SELECT TO gphkm_runtime USING (
    public.gphkm_customer_can_read_order_item(
      order_item_id,
      nullif(current_setting('app.user_id', true), ''),
      nullif(current_setting('app.organization_id', true), '')
    )
  );
CREATE POLICY customer_milestone_assigned_staff_read ON public.customer_order_item_milestone
  FOR SELECT TO gphkm_runtime USING (
    public.gphkm_staff_can_read_order_item(
      order_item_id,
      nullif(current_setting('app.user_id', true), '')
    )
  );

CREATE FUNCTION public.gphkm_record_customer_order_item_milestone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.customer_status IS NOT DISTINCT FROM NEW.customer_status
     AND OLD.next_update_at IS NOT DISTINCT FROM NEW.next_update_at THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.customer_order_item_milestone (id, order_item_id, status, next_update_at, occurred_at)
  VALUES (gen_random_uuid()::text, NEW.order_item_id, NEW.customer_status, NEW.next_update_at, clock_timestamp());
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.gphkm_record_customer_order_item_milestone() FROM PUBLIC;
CREATE TRIGGER customer_order_item_milestone_record
  AFTER INSERT OR UPDATE ON public.order_item_fulfillment
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_record_customer_order_item_milestone();

CREATE FUNCTION public.gphkm_reject_customer_order_item_milestone_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'customer order milestone history is append-only' USING ERRCODE = '55000';
END
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_customer_order_item_milestone_mutation() FROM PUBLIC;
CREATE TRIGGER customer_order_item_milestone_immutable
  BEFORE UPDATE OR DELETE ON public.customer_order_item_milestone
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_customer_order_item_milestone_mutation();
