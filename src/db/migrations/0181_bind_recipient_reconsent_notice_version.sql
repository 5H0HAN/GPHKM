-- Keep the database authorization version aligned with the customer disclosure
-- shown by the application before supplier sharing is approved.
CREATE FUNCTION public.gphkm_validate_recipient_reconsent_notice_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE request_purpose text;
BEGIN
  IF NEW.event_type <> 'CONSENTED' THEN RETURN NEW; END IF;
  SELECT request.purpose INTO request_purpose
    FROM public.order_item_content_change_request request
   WHERE request.id = NEW.request_id;
  IF request_purpose = 'RECIPIENT_RECONSENT'
     AND NEW.notice_version IS DISTINCT FROM 'gphkm-content-sharing-v1' THEN
    RAISE EXCEPTION 'recipient consent must use the current sharing disclosure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_validate_recipient_reconsent_notice_version() FROM PUBLIC;
CREATE TRIGGER content_event_recipient_reconsent_notice_guard
  BEFORE INSERT ON public.order_item_content_change_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_validate_recipient_reconsent_notice_version();
