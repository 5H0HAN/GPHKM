-- Manual handoff evidence is mutable only during its audited state transition.
-- Provider acceptance/delivery timestamps remain mutable on SEND attempts for
-- the existing webhook and reconciliation paths.
CREATE OR REPLACE FUNCTION public.gphkm_packet_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE latest_event public.supplier_packet_attempt_event%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.type = 'SEND' AND NEW.state <> 'SENDING')
      OR (NEW.type = 'MANUAL_SEND' AND NEW.state <> 'SENDING')
      OR (NEW.type IN ('EML_EXPORT','PDF_EXPORT') AND NEW.state <> 'EXPORTED')
      OR (NEW.type = 'MANUAL_SENT' AND NEW.state <> 'MANUAL_SENT') THEN
      RAISE EXCEPTION 'invalid initial supplier packet attempt state' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' OR (NEW.id,NEW.packet_id,NEW.type,NEW.actor_user_id,NEW.recipient,NEW.idempotency_key,
      NEW.resend_reason,NEW.provider,NEW.created_at)
    IS DISTINCT FROM
      (OLD.id,OLD.packet_id,OLD.type,OLD.actor_user_id,OLD.recipient,OLD.idempotency_key,
      OLD.resend_reason,OLD.provider,OLD.created_at) THEN
    RAISE EXCEPTION 'supplier packet attempt identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.state <> OLD.state THEN
    SELECT * INTO latest_event FROM public.supplier_packet_attempt_event e
      WHERE e.attempt_id = OLD.id AND e.actor_user_id IS NOT DISTINCT FROM nullif(current_setting('app.user_id',true),'')
        AND e.from_state IS NOT DISTINCT FROM OLD.state AND e.to_state = NEW.state
        AND e.created_at >= transaction_timestamp() ORDER BY e.created_at DESC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'packet attempt state change requires append-only history' USING ERRCODE = '23514'; END IF;
    IF OLD.type = 'MANUAL_SEND' THEN
      IF OLD.state <> 'SENDING' OR NEW.state NOT IN ('MANUAL_SENT','RECONCILED_FAILED')
        OR OLD.manual_message_reference IS NOT NULL OR OLD.sent_at IS NOT NULL
        OR NEW.provider_reference IS NOT NULL OR NEW.accepted_at IS NOT NULL
        OR NEW.delivered_at IS NOT NULL OR NEW.unknown_at IS NOT NULL
        OR (NEW.state = 'MANUAL_SENT' AND (NEW.sent_at IS NULL OR NEW.manual_message_reference IS NULL
          OR NEW.sent_at < OLD.created_at OR NEW.sent_at > now() + interval '5 minutes' OR NEW.resolved_at IS NULL))
        OR (NEW.state = 'RECONCILED_FAILED' AND (NEW.sent_at IS NOT NULL OR NEW.manual_message_reference IS NOT NULL OR NEW.resolved_at IS NULL)) THEN
        RAISE EXCEPTION 'invalid manual packet attempt resolution' USING ERRCODE = '23514';
      END IF;
    ELSIF (NEW.manual_message_reference,NEW.sent_at) IS DISTINCT FROM (OLD.manual_message_reference,OLD.sent_at) THEN
      RAISE EXCEPTION 'manual handoff evidence is immutable for this attempt type' USING ERRCODE = '23514';
    END IF;
    IF NOT (
      (OLD.type = 'SEND' AND OLD.state = 'SENDING' AND NEW.state IN ('ACCEPTED','DELIVERED','UNKNOWN','DELIVERY_ISSUE','RECONCILED_FAILED'))
      OR (OLD.type = 'SEND' AND OLD.state = 'UNKNOWN' AND NEW.state IN ('ACCEPTED','DELIVERED','DELIVERY_ISSUE','RECONCILED_FAILED'))
      OR (OLD.type = 'SEND' AND OLD.state = 'ACCEPTED' AND NEW.state IN ('DELIVERED','DELIVERY_ISSUE'))
      OR (OLD.type = 'SEND' AND OLD.state = 'DELIVERY_ISSUE' AND NEW.state = 'DELIVERED')
      OR (OLD.type = 'MANUAL_SEND' AND OLD.state = 'SENDING' AND NEW.state IN ('MANUAL_SENT','RECONCILED_FAILED'))
    ) THEN RAISE EXCEPTION 'invalid supplier packet attempt transition' USING ERRCODE = '23514'; END IF;
  ELSIF OLD.type = 'MANUAL_SEND' THEN
    IF (NEW.id,NEW.packet_id,NEW.type,NEW.actor_user_id,NEW.recipient,NEW.idempotency_key,NEW.resend_reason,
        NEW.provider,NEW.provider_reference,NEW.manual_message_reference,NEW.sent_at,NEW.accepted_at,NEW.delivered_at,
        NEW.unknown_at,NEW.resolved_at,NEW.created_at,NEW.state)
       IS DISTINCT FROM
       (OLD.id,OLD.packet_id,OLD.type,OLD.actor_user_id,OLD.recipient,OLD.idempotency_key,OLD.resend_reason,
        OLD.provider,OLD.provider_reference,OLD.manual_message_reference,OLD.sent_at,OLD.accepted_at,OLD.delivered_at,
        OLD.unknown_at,OLD.resolved_at,OLD.created_at,OLD.state) THEN
      RAISE EXCEPTION 'manual packet attempt evidence requires an audited state transition' USING ERRCODE = '23514';
    END IF;
  ELSIF (NEW.manual_message_reference,NEW.sent_at) IS DISTINCT FROM (OLD.manual_message_reference,OLD.sent_at) THEN
    RAISE EXCEPTION 'manual handoff evidence requires a state transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
