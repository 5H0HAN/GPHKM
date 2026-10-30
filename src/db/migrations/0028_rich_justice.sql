ALTER TABLE "customer_notification_email_provider_event" ADD COLUMN "event_created_at" timestamp with time zone NOT NULL;
CREATE OR REPLACE FUNCTION public.gphkm_finish_customer_notification_email(target_outbox_id text, target_worker_id text,
  target_state text, target_provider_reference text, target_error_code text, target_next_attempt_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  changed integer;
BEGIN
  IF session_user <> 'gphkm_worker' OR target_outbox_id !~ '^[0-9a-f-]{36}$'
    OR target_worker_id !~ '^[0-9a-f-]{36}$'
    OR target_state NOT IN ('SENT','RETRY','UNKNOWN','FAILED','SKIPPED')
    OR (target_error_code IS NOT NULL AND target_error_code !~ '^[A-Z0-9_]{1,60}$')
    OR (target_state = 'SENT' AND (target_provider_reference IS NULL OR length(target_provider_reference) NOT BETWEEN 1 AND 128))
    OR (target_state <> 'SENT' AND target_provider_reference IS NOT NULL)
    OR (target_state = 'RETRY' AND target_next_attempt_at IS NULL)
    OR (target_state <> 'RETRY' AND target_next_attempt_at IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid notification delivery result' USING ERRCODE = '42501';
  END IF;

  UPDATE public.customer_notification_email_outbox q
    SET status = target_state,
        provider_reference = target_provider_reference,
        sent_at = CASE WHEN target_state = 'SENT' THEN now() ELSE NULL END,
        next_attempt_at = coalesce(target_next_attempt_at, q.next_attempt_at),
        delivery_status = CASE WHEN target_state = 'SENT' THEN coalesce((
          SELECT CASE e.event_type WHEN 'email.delivered' THEN 'DELIVERED' WHEN 'email.bounced' THEN 'BOUNCED'
            WHEN 'email.failed' THEN 'FAILED' WHEN 'email.delivery_delayed' THEN 'DELAYED' END
          FROM public.customer_notification_email_provider_event e
          WHERE e.outbox_id = q.id AND e.provider_reference = target_provider_reference AND e.state = 'PROCESSED'
          ORDER BY e.event_created_at DESC, e.provider_event_id DESC LIMIT 1
        ), 'PENDING') ELSE q.delivery_status END,
        last_error_code = target_error_code,
        lease_id = NULL, lease_until = NULL, updated_at = now()
    WHERE q.id = target_outbox_id AND q.status = 'SENDING' AND q.lease_id = target_worker_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE FUNCTION public.gphkm_process_customer_notification_email_event(target_event_id text, target_event_type text,
  target_email_id text, target_tagged_outbox_id text, target_payload_hash text, target_event_created_at timestamptz)
RETURNS TABLE(matched boolean, duplicate boolean, result_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  matched_id text;
  current_status text;
  inserted_id text;
  event_state text;
  event_delivery_status text;
  newest_event_id text;
BEGIN
  IF nullif(current_setting('app.resend_webhook_verified', true), '') <> 'true'
    OR target_event_id IS NULL OR target_event_id !~ '^[-A-Za-z0-9_]{1,200}$'
    OR target_event_type NOT IN ('email.delivered','email.bounced','email.failed','email.delivery_delayed')
    OR target_email_id IS NULL OR target_email_id !~ '^[A-Za-z0-9_-]{1,128}$'
    OR target_payload_hash IS NULL OR target_payload_hash !~ '^[0-9a-f]{64}$'
    OR target_event_created_at IS NULL THEN
    RAISE EXCEPTION 'invalid verified notification email event' USING ERRCODE = '42501';
  END IF;
  IF target_tagged_outbox_id IS NOT NULL AND target_tagged_outbox_id !~ '^[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'invalid notification email tag' USING ERRCODE = '22023';
  END IF;

  IF target_tagged_outbox_id IS NOT NULL THEN
    SELECT q.id, q.status INTO matched_id, current_status FROM public.customer_notification_email_outbox q
      WHERE q.id = target_tagged_outbox_id AND (q.provider_reference IS NULL OR q.provider_reference = target_email_id)
      FOR UPDATE;
  ELSE
    SELECT q.id, q.status INTO matched_id, current_status FROM public.customer_notification_email_outbox q
      WHERE q.provider_reference = target_email_id FOR UPDATE;
  END IF;

  event_delivery_status := CASE target_event_type
    WHEN 'email.delivered' THEN 'DELIVERED' WHEN 'email.bounced' THEN 'BOUNCED'
    WHEN 'email.failed' THEN 'FAILED' WHEN 'email.delivery_delayed' THEN 'DELAYED' END;
  event_state := CASE WHEN matched_id IS NOT NULL AND current_status IN ('SENDING','UNKNOWN','RETRY','FAILED','SENT')
    THEN 'PROCESSED' ELSE 'RECONCILIATION_REQUIRED' END;
  INSERT INTO public.customer_notification_email_provider_event(id, provider_event_id, outbox_id, provider_reference,
    event_type, payload_hash, event_created_at, state, received_at, processed_at)
  VALUES (gen_random_uuid()::text, target_event_id, matched_id, target_email_id, target_event_type, target_payload_hash,
    target_event_created_at, event_state, now(), CASE WHEN matched_id IS NULL THEN NULL ELSE now() END)
  ON CONFLICT (provider_event_id) DO NOTHING
  RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN
    RETURN QUERY SELECT (e.outbox_id IS NOT NULL), true, e.state FROM public.customer_notification_email_provider_event e
      WHERE e.provider_event_id = target_event_id;
    RETURN;
  END IF;
  IF matched_id IS NULL OR current_status = 'SKIPPED' THEN
    RETURN QUERY SELECT false, false, 'RECONCILIATION_REQUIRED'::text;
    RETURN;
  END IF;

  IF current_status = 'SENDING' THEN
    -- The worker still owns the lease; its completion reads this event after saving the provider ID.
    RETURN QUERY SELECT true, false, 'PROCESSED'::text;
    RETURN;
  ELSIF current_status IN ('UNKNOWN','RETRY','FAILED') THEN
    UPDATE public.customer_notification_email_outbox q SET status = 'SENT', provider_reference = target_email_id,
      sent_at = coalesce(q.sent_at, now()), delivery_status = event_delivery_status,
      last_error_code = NULL, lease_id = NULL, lease_until = NULL, updated_at = now()
      WHERE q.id = matched_id;
  ELSIF current_status = 'SENT' THEN
    SELECT e.provider_event_id INTO newest_event_id FROM public.customer_notification_email_provider_event e
      WHERE e.outbox_id = matched_id AND e.state = 'PROCESSED'
      ORDER BY e.event_created_at DESC, e.provider_event_id DESC LIMIT 1;
    UPDATE public.customer_notification_email_outbox q SET delivery_status = event_delivery_status, updated_at = now()
      WHERE q.id = matched_id AND q.provider_reference = target_email_id
        AND newest_event_id = target_event_id;
  ELSE
    RETURN QUERY SELECT true, false, 'RECONCILIATION_REQUIRED'::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, false, 'PROCESSED'::text;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_process_customer_notification_email_event(text, text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_process_customer_notification_email_event(text, text, text, text, text, timestamptz) TO gphkm_runtime;
