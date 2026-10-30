-- A manual send reservation becomes acknowledgement evidence only after it
-- reaches MANUAL_SENT with a staff recorded timestamp.
CREATE OR REPLACE FUNCTION public.gphkm_supplier_packet_ack_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE attempt_row public.supplier_packet_attempt%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.recorded_by_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '') THEN
    RAISE EXCEPTION 'supplier acknowledgement is append-only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO attempt_row FROM public.supplier_packet_attempt
   WHERE id = NEW.attempt_id AND packet_id = NEW.packet_id FOR SHARE;
  IF NOT FOUND OR NOT (
       attempt_row.state = 'DELIVERED' AND attempt_row.delivered_at IS NOT NULL
       OR attempt_row.type IN ('MANUAL_SENT','MANUAL_SEND') AND attempt_row.state = 'MANUAL_SENT' AND attempt_row.sent_at IS NOT NULL
     ) OR NEW.acknowledged_at < coalesce(attempt_row.delivered_at, attempt_row.sent_at)
     OR NEW.acknowledged_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'supplier acknowledgement evidence is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
