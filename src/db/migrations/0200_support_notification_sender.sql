DROP FUNCTION public.gphkm_claim_customer_notification_emails(text, integer);
--> statement-breakpoint
CREATE FUNCTION public.gphkm_claim_customer_notification_emails(target_worker_id text, target_limit integer)
RETURNS TABLE(outbox_id text, recipient_email text, email_verified boolean, email_enabled boolean,
  subject text, body text, notification_kind text, attempts integer, first_attempt_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF session_user <> 'gphkm_worker' OR target_worker_id !~ '^[0-9a-f-]{36}$'
    OR target_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'notification worker access denied' USING ERRCODE = '42501';
  END IF;

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
    coalesce(pref.transactional_email_enabled, true), n.title, n.body, n.kind, q.attempts, q.first_attempt_at
  FROM claimed c
  JOIN public.customer_notification_email_outbox q ON q.id = c.id
  JOIN public.customer_notification n ON n.id = q.notification_id
  JOIN public.auth_user u ON u.id = n.recipient_user_id
  LEFT JOIN public.customer_notification_preference pref ON pref.user_id = n.recipient_user_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_claim_customer_notification_emails(text, integer) FROM PUBLIC, gphkm_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_claim_customer_notification_emails(text, integer) TO gphkm_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_process_customer_notification_email_event(text, text, text, text, text, timestamptz)
  TO gphkm_resend_webhook;
