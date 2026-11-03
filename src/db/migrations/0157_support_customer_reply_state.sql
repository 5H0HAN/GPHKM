ALTER TABLE "support_case_event" DROP CONSTRAINT "support_case_event_shape";--> statement-breakpoint
ALTER TABLE "support_case_event" ADD CONSTRAINT "support_case_event_shape" CHECK (("support_case_event"."kind" = 'OPENED' and "support_case_event"."audience" = 'INTERNAL' and "support_case_event"."actor_kind" = 'CUSTOMER' and "support_case_event"."from_state" is null and "support_case_event"."to_state" = 'OPEN' and "support_case_event"."decision" is null)
    or ("support_case_event"."kind" = 'OPENED' and "support_case_event"."audience" = 'INTERNAL' and "support_case_event"."actor_kind" = 'STAFF' and "support_case_event"."from_state" is null and "support_case_event"."to_state" = 'OPEN' and "support_case_event"."decision" is null)
    or ("support_case_event"."kind" = 'REPLY' and "support_case_event"."audience" = 'CUSTOMER' and "support_case_event"."from_state" is null and "support_case_event"."to_state" is null and "support_case_event"."decision" is null)
    or ("support_case_event"."kind" = 'NOTE' and "support_case_event"."audience" in ('INTERNAL','FINANCE') and "support_case_event"."actor_kind" = 'STAFF' and "support_case_event"."from_state" is null and "support_case_event"."to_state" is null and "support_case_event"."decision" is null)
    or ("support_case_event"."kind" = 'STATE_CHANGED' and "support_case_event"."audience" in ('INTERNAL','FINANCE') and "support_case_event"."actor_kind" = 'STAFF' and "support_case_event"."from_state" is not null and "support_case_event"."to_state" is not null and "support_case_event"."decision" is null)
    or ("support_case_event"."kind" = 'STATE_CHANGED' and "support_case_event"."audience" = 'INTERNAL' and "support_case_event"."actor_kind" = 'CUSTOMER' and "support_case_event"."from_state" = 'WAITING_ON_CUSTOMER' and "support_case_event"."to_state" = 'INVESTIGATING' and "support_case_event"."decision" is null)
    or ("support_case_event"."kind" = 'FINANCE_DECISION' and "support_case_event"."audience" = 'FINANCE' and "support_case_event"."actor_kind" = 'STAFF' and "support_case_event"."from_state" is null and "support_case_event"."to_state" is null and "support_case_event"."decision" is not null));
--> statement-breakpoint
DROP POLICY support_event_customer_insert ON support_case_event;
CREATE POLICY support_event_customer_insert ON support_case_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id',true),'') AND actor_kind = 'CUSTOMER'
  AND (
    (kind = 'REPLY' AND audience = 'CUSTOMER')
    OR (kind = 'OPENED' AND audience = 'INTERNAL')
    OR (kind = 'STATE_CHANGED' AND audience = 'INTERNAL'
      AND from_state = 'WAITING_ON_CUSTOMER' AND to_state = 'INVESTIGATING')
  )
  AND public.gphkm_support_customer_access(case_id, actor_user_id, nullif(current_setting('app.organization_id',true),''))
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.gphkm_support_event_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE case_row public.support_case%ROWTYPE; actor_id text := nullif(current_setting('app.user_id',true),'');
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'support history is append-only' USING ERRCODE = '23514'; END IF;
  SELECT * INTO case_row FROM public.support_case WHERE id = NEW.case_id FOR UPDATE;
  IF NOT FOUND OR case_row.state = 'CLOSED' THEN RAISE EXCEPTION 'support case is unavailable' USING ERRCODE = '23514'; END IF;
  IF NEW.kind = 'REPLY' AND NEW.actor_kind = 'CUSTOMER' AND (
    case_row.state = 'RESOLVED' OR NEW.actor_user_id <> actor_id
    OR NOT public.gphkm_support_customer_access(case_row.id, actor_id, nullif(current_setting('app.organization_id',true),''))
  ) THEN RAISE EXCEPTION 'resolved support cases cannot accept a customer reply' USING ERRCODE = '23514'; END IF;
  IF NEW.kind = 'STATE_CHANGED' AND NEW.actor_kind = 'CUSTOMER' AND (
    NEW.audience <> 'INTERNAL' OR NEW.from_state <> 'WAITING_ON_CUSTOMER' OR NEW.to_state <> 'INVESTIGATING'
    OR case_row.state <> 'WAITING_ON_CUSTOMER' OR NEW.actor_user_id <> actor_id
    OR NOT public.gphkm_support_customer_access(case_row.id, actor_id, nullif(current_setting('app.organization_id',true),''))
  ) THEN RAISE EXCEPTION 'customer reply state transition is invalid' USING ERRCODE = '23514'; END IF;
  IF NEW.kind = 'OPENED' AND (NEW.body <> case_row.summary
    OR EXISTS (SELECT 1 FROM public.support_case_event WHERE case_id = NEW.case_id AND kind = 'OPENED')
    OR (NEW.actor_kind = 'CUSTOMER' AND NEW.actor_user_id <> case_row.opened_by_user_id)
    OR (NEW.actor_kind = 'STAFF' AND (NEW.actor_user_id <> actor_id OR NOT public.gphkm_support_admin_access(case_row.id, actor_id)))) THEN
    RAISE EXCEPTION 'opening event mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'FINANCE_DECISION' AND case_row.state <> 'FINANCE_REVIEW' THEN
    RAISE EXCEPTION 'finance decision requires review' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.gphkm_support_customer_reply_resume() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE case_row public.support_case%ROWTYPE;
BEGIN
  IF NEW.kind <> 'REPLY' OR NEW.actor_kind <> 'CUSTOMER' OR NEW.audience <> 'CUSTOMER' THEN RETURN NEW; END IF;
  SELECT * INTO case_row FROM public.support_case WHERE id = NEW.case_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'support case is unavailable' USING ERRCODE = '23514'; END IF;
  IF case_row.state = 'WAITING_ON_CUSTOMER' THEN
    INSERT INTO public.support_case_event (
      id, case_id, actor_user_id, actor_kind, kind, audience, body, from_state, to_state,
      decision, idempotency_key, request_hash
    ) VALUES (
      gen_random_uuid()::text, case_row.id, NEW.actor_user_id, 'CUSTOMER', 'STATE_CHANGED', 'INTERNAL',
      'Customer replied; case returned to investigation', 'WAITING_ON_CUSTOMER', 'INVESTIGATING', NULL,
      'customer-reply-resume:' || NEW.id, NEW.request_hash
    );
    UPDATE public.support_case SET state = 'INVESTIGATING', updated_at = clock_timestamp() WHERE id = case_row.id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_support_customer_reply_resume() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER support_customer_reply_resume
  AFTER INSERT ON support_case_event FOR EACH ROW EXECUTE FUNCTION public.gphkm_support_customer_reply_resume();
