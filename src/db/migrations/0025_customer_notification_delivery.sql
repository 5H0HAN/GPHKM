-- A separate, restricted worker login claims and records email delivery without general table access.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gphkm_worker') THEN
    RAISE EXCEPTION 'Provision the restricted gphkm_worker role before applying this migration';
  END IF;
END $$;

ALTER TABLE customer_notification_email_outbox
  ADD COLUMN status text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN first_attempt_at timestamptz,
  ADD COLUMN recipient_email text,
  ADD COLUMN lease_id text,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN provider_reference text,
  ADD COLUMN last_error_code text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE customer_notification_email_outbox
  ADD CONSTRAINT customer_notification_email_status_valid CHECK (status IN ('PENDING','SENDING','RETRY','SENT','UNKNOWN','FAILED','SKIPPED')),
  ADD CONSTRAINT customer_notification_email_attempts_valid CHECK (attempts >= 0),
  ADD CONSTRAINT customer_notification_email_lease_shape CHECK (
    (status = 'SENDING' AND lease_id IS NOT NULL AND lease_until IS NOT NULL)
    OR (status <> 'SENDING' AND lease_id IS NULL AND lease_until IS NULL)
  ),
  ADD CONSTRAINT customer_notification_email_sent_shape CHECK (
    (status = 'SENT' AND sent_at IS NOT NULL AND provider_reference IS NOT NULL)
    OR (status <> 'SENT' AND sent_at IS NULL)
  ),
  ADD CONSTRAINT customer_notification_email_recipient_valid CHECK (
    recipient_email IS NULL OR (length(recipient_email) BETWEEN 3 AND 254 AND recipient_email = lower(recipient_email))
  ),
  ADD CONSTRAINT customer_notification_email_provider_ref_length CHECK (provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 128),
  ADD CONSTRAINT customer_notification_email_error_code_valid CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,60}$');
CREATE INDEX customer_notification_email_queue_idx ON customer_notification_email_outbox(status, next_attempt_at, created_at);
CREATE UNIQUE INDEX customer_notification_email_provider_ref_uq ON customer_notification_email_outbox(provider_reference);

CREATE TABLE customer_notification_preference (
  user_id text PRIMARY KEY REFERENCES auth_user(id),
  transactional_email_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE customer_notification_preference ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON customer_notification_preference TO gphkm_runtime;
REVOKE DELETE, TRUNCATE ON customer_notification_preference FROM gphkm_runtime;
CREATE POLICY customer_notification_preference_self_read ON customer_notification_preference
  FOR SELECT TO gphkm_runtime USING (user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY customer_notification_preference_self_insert ON customer_notification_preference
  FOR INSERT TO gphkm_runtime WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY customer_notification_preference_self_update ON customer_notification_preference
  FOR UPDATE TO gphkm_runtime USING (user_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));

CREATE FUNCTION public.gphkm_claim_customer_notification_emails(target_worker_id text, target_limit integer)
RETURNS TABLE(outbox_id text, recipient_email text, email_verified boolean, email_enabled boolean,
  subject text, body text, attempts integer, first_attempt_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF session_user <> 'gphkm_worker' OR target_worker_id !~ '^[0-9a-f-]{36}$'
    OR target_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'notification worker access denied' USING ERRCODE = '42501';
  END IF;

  -- An expired lease may have sent already; make it review-only, never auto-retry it.
  UPDATE public.customer_notification_email_outbox q
    SET status = 'UNKNOWN', lease_id = NULL, lease_until = NULL,
        last_error_code = 'LEASE_EXPIRED_REVIEW', updated_at = now()
    WHERE q.status = 'SENDING' AND q.lease_until < now();

  RETURN QUERY
  WITH candidates AS (
    SELECT q.id FROM public.customer_notification_email_outbox q
    WHERE q.status IN ('PENDING','RETRY') AND q.next_attempt_at <= now()
    ORDER BY q.created_at, q.id LIMIT target_limit FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.customer_notification_email_outbox q
      SET status = 'SENDING', attempts = q.attempts + 1,
          first_attempt_at = coalesce(q.first_attempt_at, now()),
          recipient_email = coalesce(q.recipient_email, lower(u.email)),
          lease_id = target_worker_id, lease_until = now() + interval '2 minutes',
          last_error_code = NULL, updated_at = now()
      FROM candidates c, public.customer_notification n, public.auth_user u
      WHERE q.id = c.id AND n.id = q.notification_id AND u.id = n.recipient_user_id
      RETURNING q.id
  )
  SELECT q.id, q.recipient_email, u.email_verified,
    coalesce(pref.transactional_email_enabled, true), n.title, n.body, q.attempts, q.first_attempt_at
  FROM claimed c
  JOIN public.customer_notification_email_outbox q ON q.id = c.id
  JOIN public.customer_notification n ON n.id = q.notification_id
  JOIN public.auth_user u ON u.id = n.recipient_user_id
  LEFT JOIN public.customer_notification_preference pref ON pref.user_id = n.recipient_user_id;
END;
$$;

CREATE FUNCTION public.gphkm_finish_customer_notification_email(target_outbox_id text, target_worker_id text,
  target_state text, target_provider_reference text, target_error_code text, target_next_attempt_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE changed integer;
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
        last_error_code = target_error_code,
        lease_id = NULL, lease_until = NULL, updated_at = now()
    WHERE q.id = target_outbox_id AND q.status = 'SENDING' AND q.lease_id = target_worker_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_claim_customer_notification_emails(text, integer) FROM PUBLIC, gphkm_runtime;
REVOKE ALL ON FUNCTION public.gphkm_finish_customer_notification_email(text, text, text, text, text, timestamptz) FROM PUBLIC, gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_claim_customer_notification_emails(text, integer) TO gphkm_worker;
GRANT EXECUTE ON FUNCTION public.gphkm_finish_customer_notification_email(text, text, text, text, text, timestamptz) TO gphkm_worker;
