-- Serialize a linked webhook with Finance resolution by acquiring the same
-- payment-attempt lock before the verified event is persisted. This closes the
-- gap between provider delivery and the event's later state transition.
CREATE FUNCTION public.gphkm_lock_attempt_before_stripe_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.provider = 'STRIPE' AND NEW.related_payment_id IS NOT NULL THEN
    PERFORM 1 FROM public.payment_attempt
     WHERE provider = 'STRIPE' AND provider_payment_id = NEW.related_payment_id
     FOR UPDATE;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_lock_attempt_before_stripe_event() FROM PUBLIC;
CREATE TRIGGER provider_event_lock_attempt_before_insert
  BEFORE INSERT ON public.provider_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_lock_attempt_before_stripe_event();
