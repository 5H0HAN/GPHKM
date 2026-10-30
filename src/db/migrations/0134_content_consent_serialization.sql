-- Customer consent is append-only but must serialize with supplier handoff.
-- The application runtime cannot SELECT FOR UPDATE through the customer RLS
-- policy, so perform the row lock inside this SECURITY DEFINER trigger.
CREATE OR REPLACE FUNCTION public.gphkm_validate_content_change_event_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  version_row public.order_item_content_version%ROWTYPE;
  request_item text;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
BEGIN
  IF NEW.event_type IN ('APPROVED','CONSENTED') THEN
    IF NEW.version_id IS NULL THEN RAISE EXCEPTION 'approved content event requires a version' USING ERRCODE = '23514'; END IF;
    SELECT * INTO version_row FROM public.order_item_content_version v WHERE v.id = NEW.version_id AND v.request_id = NEW.request_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'content version does not belong to request' USING ERRCODE = '23514'; END IF;
    IF NEW.content_hash IS DISTINCT FROM version_row.content_hash THEN
      RAISE EXCEPTION 'event hash does not match bound content, supplier and recipient' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.event_type = 'CONSENTED' THEN
    SELECT r.order_item_id INTO request_item FROM public.order_item_content_change_request r WHERE r.id = NEW.request_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'content request unavailable' USING ERRCODE = '23514'; END IF;
    SELECT * INTO fulfillment_row FROM public.order_item_fulfillment f
      WHERE f.order_item_id = request_item FOR UPDATE;
    IF NOT FOUND OR NOT public.gphkm_change_request_before_handoff(request_item) THEN
      RAISE EXCEPTION 'content consent closes after handoff' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
