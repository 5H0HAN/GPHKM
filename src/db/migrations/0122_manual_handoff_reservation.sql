-- Reserve the cancellation boundary before a staff member leaves GPHKM to send
-- an exported packet from an external mail client. The attempt remains pending
-- until staff records the actual send or reconciles it as definitely unsent.
DO $$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.supplier_packet_attempt'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%type%'
       AND pg_get_constraintdef(oid) LIKE '%MANUAL_SENT%'
  LOOP
    EXECUTE format('ALTER TABLE public.supplier_packet_attempt DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END $$;

ALTER TABLE public.supplier_packet_attempt
  ADD CONSTRAINT supplier_packet_attempt_type_valid
    CHECK (type IN ('SEND','EML_EXPORT','PDF_EXPORT','MANUAL_SENT','MANUAL_SEND')),
  ADD CONSTRAINT supplier_packet_attempt_shape CHECK (
    (type = 'SEND' AND provider = 'RESEND' AND state NOT IN ('EXPORTED','MANUAL_SENT'))
    OR (type IN ('EML_EXPORT','PDF_EXPORT') AND state = 'EXPORTED' AND provider IS NULL)
    OR (type = 'MANUAL_SENT' AND state = 'MANUAL_SENT' AND provider IS NULL
      AND manual_message_reference IS NOT NULL AND sent_at IS NOT NULL)
    OR (type = 'MANUAL_SEND' AND provider IS NULL AND (
      (state = 'SENDING' AND manual_message_reference IS NULL AND sent_at IS NULL)
      OR (state = 'MANUAL_SENT' AND manual_message_reference IS NOT NULL AND sent_at IS NOT NULL)
      OR (state = 'RECONCILED_FAILED' AND manual_message_reference IS NULL AND sent_at IS NULL)
    ))
  );

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

CREATE OR REPLACE FUNCTION public.gphkm_require_persisted_supplier_handoff() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE fulfillment_supplier_id text;
BEGIN
  IF NOT (
    (NEW.state = 'IN_FULFILLMENT' AND OLD.state IS DISTINCT FROM NEW.state)
    OR (NEW.work_started_at IS NOT NULL AND OLD.work_started_at IS DISTINCT FROM NEW.work_started_at)
  ) THEN RETURN NEW; END IF;
  SELECT fs.supplier_id INTO fulfillment_supplier_id FROM public.order_item_fulfillment_supplier fs
    WHERE fs.order_item_id = NEW.order_item_id;
  IF fulfillment_supplier_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.supplier_packet_item pi
    JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = pi.packet_id
    WHERE pi.order_item_id = NEW.order_item_id AND (
      (attempt.type = 'SEND' AND attempt.state = 'DELIVERED' AND attempt.delivered_at IS NOT NULL)
      OR (attempt.type IN ('MANUAL_SENT','MANUAL_SEND') AND attempt.state = 'MANUAL_SENT' AND attempt.sent_at IS NOT NULL)
    )
  ) THEN RAISE EXCEPTION 'supplier placement requires persisted delivery or manual handoff evidence' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.gphkm_supplier_packet_manual_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE attempt_row public.supplier_packet_attempt%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.uploaded_by_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '') THEN
    RAISE EXCEPTION 'supplier packet evidence is append-only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO attempt_row FROM public.supplier_packet_attempt
    WHERE id = NEW.attempt_id AND packet_id = NEW.packet_id FOR SHARE;
  IF NOT FOUND OR attempt_row.type NOT IN ('MANUAL_SENT','MANUAL_SEND') OR attempt_row.state <> 'MANUAL_SENT'
     OR attempt_row.sent_at IS NULL OR NOT public.gphkm_supplier_packet_access(NEW.packet_id, NEW.uploaded_by_user_id)
     OR NEW.created_at < attempt_row.created_at - interval '5 minutes'
     OR NEW.created_at > now() + interval '5 minutes'
     OR (NEW.file_kind = 'EML' AND NEW.file_name !~ '\.eml$')
     OR (NEW.file_kind = 'PDF' AND NEW.file_name !~ '\.pdf$') THEN
    RAISE EXCEPTION 'supplier packet evidence does not match a manual send' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
