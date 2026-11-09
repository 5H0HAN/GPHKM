-- A supplier packet is the only path from READY_FOR_HANDOFF into
-- HANDOFF_PENDING. Manual send sets the cancellation cutoff; a matching
-- supplier receipt acknowledgement is required before work can start.
CREATE OR REPLACE FUNCTION public.gphkm_require_persisted_supplier_handoff() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE fulfillment_supplier_id text; current_route_generation integer;
BEGIN
  IF NOT (
    (NEW.state = 'HANDOFF_PENDING' AND OLD.state IS DISTINCT FROM NEW.state)
    OR (NEW.state = 'IN_FULFILLMENT' AND OLD.state IS DISTINCT FROM NEW.state)
    OR (NEW.work_started_at IS NOT NULL AND OLD.work_started_at IS DISTINCT FROM NEW.work_started_at)
  ) THEN RETURN NEW; END IF;

  -- The fulfillment row is already locked by this UPDATE. Lock the route
  -- second, matching equivalent-offer acceptance's item-then-route order.
  SELECT fs.supplier_id, fs.route_generation
    INTO fulfillment_supplier_id, current_route_generation
    FROM public.order_item_fulfillment_supplier fs
   WHERE fs.order_item_id = NEW.order_item_id
   FOR KEY SHARE OF fs;
  IF fulfillment_supplier_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.state = 'HANDOFF_PENDING' AND OLD.state IS DISTINCT FROM NEW.state THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.supplier_packet_item pi
        JOIN public.supplier_packet packet ON packet.id = pi.packet_id
       WHERE pi.order_item_id = NEW.order_item_id
         AND pi.route_generation = current_route_generation
         AND packet.supplier_id = fulfillment_supplier_id
         AND packet.superseded_at IS NULL
         AND packet.version = (
           SELECT max(latest.version)
             FROM public.supplier_packet latest
             JOIN public.supplier_packet_item latest_item ON latest_item.packet_id = latest.id
            WHERE latest_item.order_item_id = NEW.order_item_id
              AND latest.supplier_id = fulfillment_supplier_id
              AND latest.superseded_at IS NULL
         )
    ) THEN
      RAISE EXCEPTION 'supplier packet preparation is required before handoff' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.supplier_packet_item pi
      JOIN public.supplier_packet packet ON packet.id = pi.packet_id
      JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = packet.id
     WHERE pi.order_item_id = NEW.order_item_id
       AND pi.route_generation = current_route_generation
       AND packet.supplier_id = fulfillment_supplier_id
       AND packet.superseded_at IS NULL
       AND packet.version = (
         SELECT max(latest.version)
           FROM public.supplier_packet latest
           JOIN public.supplier_packet_item latest_item ON latest_item.packet_id = latest.id
          WHERE latest_item.order_item_id = NEW.order_item_id
            AND latest.supplier_id = fulfillment_supplier_id
            AND latest.superseded_at IS NULL
       )
       AND (
         (attempt.type = 'SEND' AND attempt.state = 'DELIVERED' AND attempt.delivered_at IS NOT NULL)
         OR (
           attempt.type IN ('MANUAL_SENT','MANUAL_SEND')
           AND attempt.state = 'MANUAL_SENT'
           AND attempt.sent_at IS NOT NULL
           AND EXISTS (
             SELECT 1
               FROM public.supplier_packet_acknowledgement acknowledgement
              WHERE acknowledgement.packet_id = packet.id
                AND acknowledgement.attempt_id = attempt.id
           )
         )
       )
  ) THEN
    RAISE EXCEPTION 'supplier placement requires delivery or manual receipt acknowledgement for the current packet' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_require_persisted_supplier_handoff() FROM PUBLIC;
