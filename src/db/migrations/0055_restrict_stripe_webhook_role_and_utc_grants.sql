-- Only the signature-verifying webhook route uses this database identity.
-- The general request runtime must not be able to manufacture settlement facts.
REVOKE ALL ON FUNCTION public.gphkm_process_stripe_event(text,text,text,text,text,text,text,numeric,text,text,timestamptz,text,text)
  FROM PUBLIC, gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_process_stripe_event(text,text,text,text,text,text,text,numeric,text,text,timestamptz,text,text)
  TO gphkm_webhook;
REVOKE ALL ON FUNCTION public.gphkm_attach_stripe_event_facts(text,text,numeric,text,text)
  FROM PUBLIC, gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_attach_stripe_event_facts(text,text,numeric,text,text)
  TO gphkm_webhook;

-- Calendar-month addition to timestamptz follows the session timezone unless
-- pinned. Keep the approved access term arithmetic in UTC for every caller.
ALTER FUNCTION public.gphkm_process_stripe_event(text,text,text,text,text,text,text,numeric,text,text,timestamptz,text,text)
  SET TimeZone TO 'UTC';
