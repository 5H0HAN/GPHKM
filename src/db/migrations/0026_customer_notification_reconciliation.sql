CREATE TABLE customer_notification_email_reconciliation (
  id text PRIMARY KEY,
  outbox_id text NOT NULL REFERENCES customer_notification_email_outbox(id),
  actor_user_id text NOT NULL REFERENCES auth_user(id),
  decision text NOT NULL CHECK (decision IN ('CONFIRMED_SENT','CONFIRMED_NOT_SENT')),
  provider_reference text,
  evidence_reference text NOT NULL CHECK (length(evidence_reference) BETWEEN 3 AND 200),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((decision = 'CONFIRMED_SENT' AND provider_reference IS NOT NULL AND length(provider_reference) BETWEEN 1 AND 128)
    OR (decision = 'CONFIRMED_NOT_SENT' AND provider_reference IS NULL))
);
ALTER TABLE customer_notification_email_reconciliation ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON customer_notification_email_reconciliation TO gphkm_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON customer_notification_email_reconciliation FROM gphkm_runtime;
CREATE INDEX customer_notification_email_reconciliation_outbox_idx
  ON customer_notification_email_reconciliation(outbox_id, created_at);
CREATE POLICY customer_notification_email_reconciliation_super_admin_read
  ON customer_notification_email_reconciliation FOR SELECT TO gphkm_runtime
  USING (public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN'));

CREATE FUNCTION public.gphkm_reject_notification_reconciliation_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'notification reconciliation history is append-only' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_notification_reconciliation_mutation() FROM PUBLIC;
CREATE TRIGGER customer_notification_email_reconciliation_append_only
  BEFORE UPDATE OR DELETE ON customer_notification_email_reconciliation
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_notification_reconciliation_mutation();

CREATE FUNCTION public.gphkm_list_unknown_customer_notification_emails()
RETURNS TABLE(outbox_id text, notification_kind text, created_at timestamptz, attempts integer, error_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'notification reconciliation unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT q.id, n.kind, q.created_at, q.attempts, q.last_error_code
    FROM public.customer_notification_email_outbox q
    JOIN public.customer_notification n ON n.id = q.notification_id
    WHERE q.status = 'UNKNOWN'
    ORDER BY q.updated_at, q.id LIMIT 100;
END;
$$;

CREATE FUNCTION public.gphkm_reconcile_customer_notification_email(target_outbox_id text, target_decision text,
  target_provider_reference text, target_evidence_reference text, target_reason text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  org_id text;
  changed integer;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')
    OR target_outbox_id !~ '^[0-9a-f-]{36}$'
    OR target_decision NOT IN ('CONFIRMED_SENT','CONFIRMED_NOT_SENT')
    OR target_evidence_reference IS NULL OR length(btrim(target_evidence_reference)) NOT BETWEEN 3 AND 200
    OR target_evidence_reference ~ '[[:cntrl:]]'
    OR target_reason IS NULL OR length(btrim(target_reason)) NOT BETWEEN 10 AND 1000
    OR target_reason ~ '[[:cntrl:]]'
    OR (target_decision = 'CONFIRMED_SENT' AND (target_provider_reference IS NULL OR target_provider_reference !~ '^[A-Za-z0-9_-]{1,128}$'))
    OR (target_decision = 'CONFIRMED_NOT_SENT' AND target_provider_reference IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid notification reconciliation decision' USING ERRCODE = '42501';
  END IF;

  SELECT n.organization_id INTO org_id FROM public.customer_notification_email_outbox q
    JOIN public.customer_notification n ON n.id = q.notification_id
    WHERE q.id = target_outbox_id AND q.status = 'UNKNOWN' FOR UPDATE OF q;
  IF org_id IS NULL THEN RETURN false; END IF;

  UPDATE public.customer_notification_email_outbox q
    SET status = CASE WHEN target_decision = 'CONFIRMED_SENT' THEN 'SENT' ELSE 'RETRY' END,
        provider_reference = target_provider_reference,
        sent_at = CASE WHEN target_decision = 'CONFIRMED_SENT' THEN now() ELSE NULL END,
        delivery_status = CASE WHEN target_decision = 'CONFIRMED_SENT' THEN q.delivery_status ELSE 'PENDING' END,
        next_attempt_at = CASE WHEN target_decision = 'CONFIRMED_NOT_SENT' THEN now() ELSE q.next_attempt_at END,
        last_error_code = NULL, lease_id = NULL, lease_until = NULL, updated_at = now()
    WHERE q.id = target_outbox_id AND q.status = 'UNKNOWN';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RETURN false; END IF;

  INSERT INTO public.customer_notification_email_reconciliation(id, outbox_id, actor_user_id, decision,
    provider_reference, evidence_reference, reason)
  VALUES (gen_random_uuid()::text, target_outbox_id, actor_id, target_decision,
    target_provider_reference, btrim(target_evidence_reference), btrim(target_reason));
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
  VALUES (gen_random_uuid()::text, org_id, actor_id, 'CUSTOMER_NOTIFICATION_EMAIL_RECONCILED',
    'CUSTOMER_NOTIFICATION_EMAIL', target_outbox_id, target_decision,
    jsonb_build_object('result', CASE WHEN target_decision = 'CONFIRMED_SENT' THEN 'SENT' ELSE 'RETRY_QUEUED' END));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_list_unknown_customer_notification_emails() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gphkm_reconcile_customer_notification_email(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_list_unknown_customer_notification_emails() TO gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_reconcile_customer_notification_email(text, text, text, text, text) TO gphkm_runtime;
