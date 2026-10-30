-- Persist Resend's message identity with each signed event so delivery webhooks
-- can correlate by the immutable packet-attempt tag even before the send POST
-- response has saved the provider reference.
ALTER TABLE public.supplier_packet_provider_event
  ADD COLUMN provider_email_id text,
  ADD CONSTRAINT supplier_packet_provider_email_id_valid
    CHECK (provider_email_id IS NULL OR (length(btrim(provider_email_id)) BETWEEN 1 AND 320 AND provider_email_id !~ '[[:cntrl:]]'));

CREATE INDEX supplier_packet_provider_email_id_idx
  ON public.supplier_packet_provider_event(provider_email_id)
  WHERE provider_email_id IS NOT NULL;

-- A Resend email ID belongs to one packet attempt. This also closes concurrent
-- signed-webhook races that might otherwise attach one ID to two attempts.
DROP INDEX public.supplier_packet_attempt_provider_reference_idx;
CREATE UNIQUE INDEX supplier_packet_attempt_provider_reference_uq
  ON public.supplier_packet_attempt(provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

-- A verified webhook may compare a duplicate event ID and its persisted message
-- identity before returning idempotently. Staff policies remain unchanged.
CREATE POLICY supplier_packet_provider_event_webhook_read
  ON public.supplier_packet_provider_event FOR SELECT TO gphkm_runtime
  USING (nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
    AND provider_event_id = nullif(current_setting('app.resend_webhook_event_id', true), ''));

DROP POLICY supplier_packet_provider_event_webhook_insert ON public.supplier_packet_provider_event;
CREATE POLICY supplier_packet_provider_event_webhook_insert
  ON public.supplier_packet_provider_event FOR INSERT TO gphkm_runtime
  WITH CHECK (nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
    AND provider_event_id = nullif(current_setting('app.resend_webhook_event_id', true), '')
    AND provider_email_id = nullif(current_setting('app.resend_webhook_email_id', true), ''));

DROP POLICY supplier_packet_attempt_webhook_read ON public.supplier_packet_attempt;
CREATE POLICY supplier_packet_attempt_webhook_read
  ON public.supplier_packet_attempt FOR SELECT TO gphkm_runtime
  USING (nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
    AND provider = 'RESEND' AND type = 'SEND'
    AND (id = nullif(current_setting('app.resend_webhook_attempt_id', true), '')
      OR provider_reference = nullif(current_setting('app.resend_webhook_email_id', true), '')));

DROP POLICY supplier_packet_attempt_webhook_update ON public.supplier_packet_attempt;
CREATE POLICY supplier_packet_attempt_webhook_update
  ON public.supplier_packet_attempt FOR UPDATE TO gphkm_runtime
  USING (nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
    AND provider = 'RESEND' AND type = 'SEND'
    AND (id = nullif(current_setting('app.resend_webhook_attempt_id', true), '')
      OR provider_reference = nullif(current_setting('app.resend_webhook_email_id', true), '')))
  WITH CHECK (nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
    AND provider = 'RESEND' AND type = 'SEND'
    AND (id = nullif(current_setting('app.resend_webhook_attempt_id', true), '')
      OR provider_reference = nullif(current_setting('app.resend_webhook_email_id', true), '')));

DROP POLICY supplier_packet_attempt_event_webhook_insert ON public.supplier_packet_attempt_event;
CREATE POLICY supplier_packet_attempt_event_webhook_insert
  ON public.supplier_packet_attempt_event FOR INSERT TO gphkm_runtime
  WITH CHECK (actor_kind = 'PROVIDER' AND actor_user_id IS NULL
    AND nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
    AND EXISTS (SELECT 1 FROM public.supplier_packet_attempt a WHERE a.id = attempt_id
      AND a.provider = 'RESEND' AND a.type = 'SEND'
      AND (a.id = nullif(current_setting('app.resend_webhook_attempt_id', true), '')
        OR a.provider_reference = nullif(current_setting('app.resend_webhook_email_id', true), ''))));
