CREATE TABLE "invitation_email_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_invitation_id" text,
	"staff_invitation_id" text,
	"recipient_email" text NOT NULL,
	"token_ciphertext" text,
	"token_nonce" text,
	"token_tag" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"lease_id" text,
	"lease_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_reference" text,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_email_one_target" CHECK (("invitation_email_outbox"."organization_invitation_id" is not null and "invitation_email_outbox"."staff_invitation_id" is null) or ("invitation_email_outbox"."organization_invitation_id" is null and "invitation_email_outbox"."staff_invitation_id" is not null)),
	CONSTRAINT "invitation_email_status_valid" CHECK ("invitation_email_outbox"."status" in ('PENDING','SENDING','RETRY','SENT','UNKNOWN','FAILED','SKIPPED')),
	CONSTRAINT "invitation_email_attempts_valid" CHECK ("invitation_email_outbox"."attempts" >= 0),
	CONSTRAINT "invitation_email_lease_shape" CHECK (("invitation_email_outbox"."status" = 'SENDING' and "invitation_email_outbox"."lease_id" is not null and "invitation_email_outbox"."lease_until" is not null) or ("invitation_email_outbox"."status" <> 'SENDING' and "invitation_email_outbox"."lease_id" is null and "invitation_email_outbox"."lease_until" is null)),
	CONSTRAINT "invitation_email_sent_shape" CHECK (("invitation_email_outbox"."status" = 'SENT' and "invitation_email_outbox"."sent_at" is not null and "invitation_email_outbox"."provider_reference" is not null) or ("invitation_email_outbox"."status" <> 'SENT' and "invitation_email_outbox"."sent_at" is null)),
	CONSTRAINT "invitation_email_token_shape" CHECK (("invitation_email_outbox"."status" in ('PENDING','SENDING','RETRY') and "invitation_email_outbox"."token_ciphertext" is not null and "invitation_email_outbox"."token_nonce" is not null and "invitation_email_outbox"."token_tag" is not null) or ("invitation_email_outbox"."status" in ('SENT','UNKNOWN','FAILED','SKIPPED') and "invitation_email_outbox"."token_ciphertext" is null and "invitation_email_outbox"."token_nonce" is null and "invitation_email_outbox"."token_tag" is null)),
	CONSTRAINT "invitation_email_recipient_valid" CHECK (length("invitation_email_outbox"."recipient_email") between 3 and 254 and "invitation_email_outbox"."recipient_email" = lower("invitation_email_outbox"."recipient_email"))
);
--> statement-breakpoint
ALTER TABLE "invitation_email_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invitation_email_outbox" ADD CONSTRAINT "invitation_email_outbox_organization_invitation_id_organization_invitation_id_fk" FOREIGN KEY ("organization_invitation_id") REFERENCES "public"."organization_invitation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_email_outbox" ADD CONSTRAINT "invitation_email_outbox_staff_invitation_id_staff_invitation_id_fk" FOREIGN KEY ("staff_invitation_id") REFERENCES "public"."staff_invitation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_email_org_invitation_uq" ON "invitation_email_outbox" USING btree ("organization_invitation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_email_staff_invitation_uq" ON "invitation_email_outbox" USING btree ("staff_invitation_id");--> statement-breakpoint
CREATE INDEX "invitation_email_queue_idx" ON "invitation_email_outbox" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_email_provider_ref_uq" ON "invitation_email_outbox" USING btree ("provider_reference");
--> statement-breakpoint
REVOKE ALL ON public.invitation_email_outbox FROM PUBLIC, gphkm_runtime;
--> statement-breakpoint
GRANT SELECT (id, organization_invitation_id, staff_invitation_id, status) ON public.invitation_email_outbox TO gphkm_runtime;
--> statement-breakpoint
CREATE POLICY invitation_email_owner_status_read ON public.invitation_email_outbox FOR SELECT TO gphkm_runtime USING (
  organization_invitation_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.organization_invitation i
    WHERE i.id = organization_invitation_id
      AND public.gphkm_is_active_org_owner(i.organization_id, nullif(current_setting('app.user_id', true), ''))
  )
  OR staff_invitation_id IS NOT NULL AND public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
--> statement-breakpoint
CREATE POLICY organization_member_reactivate_by_invitation ON public.organization_member FOR UPDATE TO gphkm_runtime
  USING (user_id = nullif(current_setting('app.user_id', true), '')
    AND organization_id = nullif(current_setting('app.organization_id', true), '')
    AND role = 'MEMBER' AND active = false
    AND public.gphkm_valid_org_invitation(organization_id, user_id))
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')
    AND organization_id = nullif(current_setting('app.organization_id', true), '')
    AND role = 'MEMBER' AND active = true
    AND public.gphkm_valid_org_invitation(organization_id, user_id));
--> statement-breakpoint
CREATE FUNCTION public.gphkm_enqueue_invitation_email(target_id text, target_kind text, target_invitation_id text,
  target_ciphertext text, target_nonce text, target_tag text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE recipient text; actor_id text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF target_id !~ '^[0-9a-f-]{36}$' OR target_invitation_id !~ '^[0-9a-f-]{36}$'
     OR target_kind NOT IN ('ORGANIZATION','STAFF') OR target_ciphertext IS NULL OR length(target_ciphertext) NOT BETWEEN 40 AND 200
     OR target_nonce IS NULL OR length(target_nonce) <> 16 OR target_tag IS NULL OR length(target_tag) <> 22 THEN
    RAISE EXCEPTION 'invitation delivery unavailable' USING ERRCODE = '22023';
  END IF;
  IF target_kind = 'ORGANIZATION' THEN
    SELECT i.email INTO recipient FROM public.organization_invitation i
     WHERE i.id = target_invitation_id AND i.status = 'PENDING' AND i.expires_at > now()
       AND i.invited_by_user_id = actor_id
       AND public.gphkm_is_active_org_owner(i.organization_id, actor_id);
    IF recipient IS NULL THEN RAISE EXCEPTION 'invitation delivery unavailable' USING ERRCODE = '42501'; END IF;
    INSERT INTO public.invitation_email_outbox(id, organization_invitation_id, recipient_email, token_ciphertext, token_nonce, token_tag)
      VALUES (target_id, target_invitation_id, lower(recipient), target_ciphertext, target_nonce, target_tag);
  ELSE
    SELECT i.email INTO recipient FROM public.staff_invitation i
     WHERE i.id = target_invitation_id AND i.status = 'PENDING' AND i.expires_at > now()
       AND i.invited_by_user_id = actor_id AND public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN');
    IF recipient IS NULL THEN RAISE EXCEPTION 'invitation delivery unavailable' USING ERRCODE = '42501'; END IF;
    INSERT INTO public.invitation_email_outbox(id, staff_invitation_id, recipient_email, token_ciphertext, token_nonce, token_tag)
      VALUES (target_id, target_invitation_id, lower(recipient), target_ciphertext, target_nonce, target_tag);
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_enqueue_invitation_email(text,text,text,text,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_enqueue_invitation_email(text,text,text,text,text,text) TO gphkm_runtime;
--> statement-breakpoint
CREATE FUNCTION public.gphkm_cancel_invitation_email_after_state_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.status <> OLD.status AND NEW.status <> 'PENDING' THEN
    UPDATE public.invitation_email_outbox SET status = 'SKIPPED', token_ciphertext = NULL, token_nonce = NULL, token_tag = NULL,
      last_error_code = 'INVITATION_NO_LONGER_PENDING', updated_at = now()
     WHERE (organization_invitation_id = NEW.id OR staff_invitation_id = NEW.id)
       AND status IN ('PENDING','RETRY');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_cancel_invitation_email_after_state_change() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER organization_invitation_cancel_email AFTER UPDATE OF status ON public.organization_invitation
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_cancel_invitation_email_after_state_change();
--> statement-breakpoint
CREATE TRIGGER staff_invitation_cancel_email AFTER UPDATE OF status ON public.staff_invitation
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_cancel_invitation_email_after_state_change();
--> statement-breakpoint
CREATE FUNCTION public.gphkm_claim_invitation_emails(target_worker_id text, target_limit integer)
RETURNS TABLE(outbox_id text, recipient_email text, invitation_kind text, invitation_id text,
  token_ciphertext text, token_nonce text, token_tag text, organization_name text, staff_role text,
  expires_at timestamptz, attempts integer, first_attempt_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF session_user <> 'gphkm_worker' OR target_worker_id !~ '^[0-9a-f-]{36}$' OR target_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'invitation worker access denied' USING ERRCODE = '42501';
  END IF;
  UPDATE public.invitation_email_outbox q SET status = 'UNKNOWN', lease_id = NULL, lease_until = NULL,
    token_ciphertext = NULL, token_nonce = NULL, token_tag = NULL,
    last_error_code = 'LEASE_EXPIRED_REVIEW', updated_at = now()
   WHERE q.status = 'SENDING' AND q.lease_until < now();

  UPDATE public.invitation_email_outbox q SET status = 'SKIPPED', token_ciphertext = NULL, token_nonce = NULL, token_tag = NULL,
    last_error_code = 'INVITATION_EXPIRED_OR_REVOKED', updated_at = now()
   WHERE q.status IN ('PENDING','RETRY') AND (
     (q.organization_invitation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.organization_invitation i WHERE i.id = q.organization_invitation_id AND i.status = 'PENDING' AND i.expires_at > now()))
     OR (q.staff_invitation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.staff_invitation i WHERE i.id = q.staff_invitation_id AND i.status = 'PENDING' AND i.expires_at > now()))
   );

  RETURN QUERY
  WITH candidates AS (
    SELECT q.id FROM public.invitation_email_outbox q
     WHERE q.status IN ('PENDING','RETRY') AND q.next_attempt_at <= now()
       AND ((q.organization_invitation_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.organization_invitation i WHERE i.id = q.organization_invitation_id AND i.status = 'PENDING' AND i.expires_at > now()))
         OR (q.staff_invitation_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.staff_invitation i WHERE i.id = q.staff_invitation_id AND i.status = 'PENDING' AND i.expires_at > now())))
     ORDER BY q.created_at, q.id LIMIT target_limit FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.invitation_email_outbox q SET status = 'SENDING', attempts = q.attempts + 1,
      first_attempt_at = coalesce(q.first_attempt_at, now()), lease_id = target_worker_id,
      lease_until = now() + interval '2 minutes', last_error_code = NULL, updated_at = now()
     FROM candidates c WHERE q.id = c.id RETURNING q.*
  )
  SELECT q.id, q.recipient_email,
    CASE WHEN q.organization_invitation_id IS NOT NULL THEN 'ORGANIZATION' ELSE 'STAFF' END,
    coalesce(q.organization_invitation_id, q.staff_invitation_id), q.token_ciphertext, q.token_nonce, q.token_tag,
    o.name, si.role::text, coalesce(oi.expires_at, si.expires_at), q.attempts, q.first_attempt_at
   FROM claimed q
   LEFT JOIN public.organization_invitation oi ON oi.id = q.organization_invitation_id
   LEFT JOIN public.organization o ON o.id = oi.organization_id
   LEFT JOIN public.staff_invitation si ON si.id = q.staff_invitation_id
   ;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_claim_invitation_emails(text,integer) FROM PUBLIC, gphkm_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_claim_invitation_emails(text,integer) TO gphkm_worker;
--> statement-breakpoint
CREATE FUNCTION public.gphkm_finish_invitation_email(target_outbox_id text, target_worker_id text,
  target_state text, target_provider_reference text, target_error_code text, target_next_attempt_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE changed integer; org_id text; invitation_ref text; invitation_kind text;
BEGIN
  IF session_user <> 'gphkm_worker' OR target_outbox_id !~ '^[0-9a-f-]{36}$' OR target_worker_id !~ '^[0-9a-f-]{36}$'
    OR target_state NOT IN ('SENT','RETRY','UNKNOWN','FAILED','SKIPPED')
    OR (target_error_code IS NOT NULL AND target_error_code !~ '^[A-Z0-9_]{1,60}$')
    OR (target_state = 'SENT' AND (target_provider_reference IS NULL OR length(target_provider_reference) NOT BETWEEN 1 AND 128))
    OR (target_state <> 'SENT' AND target_provider_reference IS NOT NULL)
    OR (target_state = 'RETRY' AND target_next_attempt_at IS NULL)
    OR (target_state <> 'RETRY' AND target_next_attempt_at IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid invitation email result' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(i.organization_id, NULL), coalesce(i.id, s.id),
    CASE WHEN i.id IS NOT NULL THEN 'ORGANIZATION' ELSE 'STAFF' END
    INTO org_id, invitation_ref, invitation_kind
   FROM public.invitation_email_outbox q
   LEFT JOIN public.organization_invitation i ON i.id = q.organization_invitation_id
   LEFT JOIN public.staff_invitation s ON s.id = q.staff_invitation_id
   WHERE q.id = target_outbox_id;
  UPDATE public.invitation_email_outbox q SET status = target_state,
    provider_reference = target_provider_reference,
    sent_at = CASE WHEN target_state = 'SENT' THEN now() ELSE NULL END,
    next_attempt_at = coalesce(target_next_attempt_at, q.next_attempt_at),
    last_error_code = target_error_code,
    token_ciphertext = CASE WHEN target_state IN ('SENT','UNKNOWN','FAILED','SKIPPED') THEN NULL ELSE q.token_ciphertext END,
    token_nonce = CASE WHEN target_state IN ('SENT','UNKNOWN','FAILED','SKIPPED') THEN NULL ELSE q.token_nonce END,
    token_tag = CASE WHEN target_state IN ('SENT','UNKNOWN','FAILED','SKIPPED') THEN NULL ELSE q.token_tag END,
    lease_id = NULL, lease_until = NULL, updated_at = now()
   WHERE q.id = target_outbox_id AND q.status = 'SENDING' AND q.lease_id = target_worker_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed = 1 AND target_state IN ('SENT','UNKNOWN','FAILED') THEN
    INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (gen_random_uuid()::text, org_id, NULL, 'INVITATION_EMAIL_' || target_state,
      'INVITATION', invitation_ref, jsonb_build_object('kind', invitation_kind, 'providerReference', target_provider_reference, 'errorCode', target_error_code));
  END IF;
  RETURN changed = 1;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_finish_invitation_email(text,text,text,text,text,timestamptz) FROM PUBLIC, gphkm_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_finish_invitation_email(text,text,text,text,text,timestamptz) TO gphkm_worker;
