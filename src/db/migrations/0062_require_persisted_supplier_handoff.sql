-- Supplier-backed items can enter placement-in-progress only after durable
-- provider delivery or a staff-recorded manual handoff. The accepted-send
-- cancellation cutoff alone does not satisfy this requirement.
CREATE FUNCTION public.gphkm_require_persisted_supplier_handoff() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE fulfillment_supplier_id text;
BEGIN
  IF NOT (
    (NEW.state = 'IN_FULFILLMENT' AND OLD.state IS DISTINCT FROM NEW.state)
    OR (NEW.work_started_at IS NOT NULL AND OLD.work_started_at IS DISTINCT FROM NEW.work_started_at)
  ) THEN
    RETURN NEW;
  END IF;

  SELECT fs.supplier_id INTO fulfillment_supplier_id
    FROM public.order_item_fulfillment_supplier fs
    WHERE fs.order_item_id = NEW.order_item_id;
  IF fulfillment_supplier_id IS NULL THEN RETURN NEW; END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.supplier_packet_item pi
    JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = pi.packet_id
    WHERE pi.order_item_id = NEW.order_item_id
      AND (
        (attempt.type = 'SEND' AND attempt.state = 'DELIVERED' AND attempt.delivered_at IS NOT NULL)
        OR (attempt.type = 'MANUAL_SENT' AND attempt.state = 'MANUAL_SENT' AND attempt.sent_at IS NOT NULL)
      )
  ) THEN
    RAISE EXCEPTION 'supplier placement requires persisted delivery or manual handoff evidence' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_require_persisted_supplier_handoff() FROM PUBLIC;
CREATE TRIGGER fulfillment_supplier_handoff_required
  BEFORE UPDATE OF state, work_started_at ON public.order_item_fulfillment
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_require_persisted_supplier_handoff();
