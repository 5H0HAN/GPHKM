ALTER TABLE "organization_closure_event" DROP CONSTRAINT IF EXISTS "organization_closure_event_reply_shape";--> statement-breakpoint
ALTER TABLE "organization_closure_event" DROP CONSTRAINT IF EXISTS "organization_closure_event_state_shape_actor";--> statement-breakpoint
ALTER TABLE "organization_closure_event" ADD CONSTRAINT "organization_closure_event_state_shape_actor" CHECK ("organization_closure_event"."kind" <> 'STATE_CHANGED' or ("organization_closure_event"."actor_kind" = 'STAFF' and "organization_closure_event"."audience" in ('CUSTOMER','INTERNAL')));--> statement-breakpoint
ALTER TABLE "organization_closure_event" ADD CONSTRAINT "organization_closure_event_reply_shape" CHECK ("organization_closure_event"."kind" <> 'REPLY' or ("organization_closure_event"."actor_kind" in ('CUSTOMER','STAFF') and "organization_closure_event"."audience" = 'CUSTOMER'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.gphkm_closure_request_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor_id text:=nullif(current_setting('app.user_id',true),'');
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'OPEN' OR NEW.opened_by_user_id<>actor_id OR NOT public.gphkm_is_active_org_owner(NEW.organization_id,actor_id) THEN
     RAISE EXCEPTION 'closure request unavailable' USING ERRCODE='42501'; END IF;
 ELSE
   IF (NEW.id,NEW.organization_id,NEW.opened_by_user_id,NEW.summary,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.opened_by_user_id,OLD.summary,OLD.idempotency_key,OLD.request_hash,OLD.created_at) THEN
     RAISE EXCEPTION 'closure request opening is immutable' USING ERRCODE='23514'; END IF;
   IF OLD.state='CLOSED' OR (NEW.state<>OLD.state AND NEW.state NOT IN ('INVESTIGATING','WAITING_ON_CUSTOMER','CLOSED')) THEN
     RAISE EXCEPTION 'invalid closure state transition' USING ERRCODE='23514'; END IF;
   IF NEW.state<>OLD.state AND NOT EXISTS (SELECT 1 FROM public.organization_closure_event e WHERE e.request_id=OLD.id
      AND e.actor_user_id=actor_id AND e.kind='STATE_CHANGED' AND e.from_state=OLD.state AND e.to_state=NEW.state
      AND e.created_at>=transaction_timestamp()) THEN RAISE EXCEPTION 'closure state change requires history' USING ERRCODE='23514'; END IF;
   IF NEW.state<>OLD.state AND NOT EXISTS (SELECT 1 FROM public.audit_event a WHERE a.organization_id=OLD.organization_id
      AND a.actor_user_id=actor_id AND a.action='organization.closure.state_changed'
      AND a.target_type='organization_closure_request' AND a.target_id=OLD.id
      AND a.created_at>=transaction_timestamp()) THEN RAISE EXCEPTION 'closure state change requires audit' USING ERRCODE='23514'; END IF;
   IF NEW.state='CLOSED' AND (cardinality(public.gphkm_closure_blockers(OLD.organization_id))>0
      OR (NOT public.gphkm_is_active_staff(actor_id,'ADMIN') AND NOT public.gphkm_is_active_staff(actor_id,'SUPER_ADMIN'))) THEN
     RAISE EXCEPTION 'organization closure blockers remain' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.gphkm_closure_event_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE request_state text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'closure history is append-only' USING ERRCODE='42501'; END IF;
 SELECT state INTO request_state FROM public.organization_closure_request WHERE id=NEW.request_id FOR UPDATE;
 IF request_state IS NULL OR request_state='CLOSED' THEN RAISE EXCEPTION 'closure request unavailable' USING ERRCODE='23514'; END IF;
 IF NEW.kind='OPENED' AND NOT EXISTS (SELECT 1 FROM public.organization_closure_request r WHERE r.id=NEW.request_id
   AND r.opened_by_user_id=NEW.actor_user_id AND r.state='OPEN') THEN RAISE EXCEPTION 'invalid closure opening history' USING ERRCODE='23514'; END IF;
 IF NEW.kind='STATE_CHANGED' AND NOT EXISTS (SELECT 1 FROM public.organization_closure_request r WHERE r.id=NEW.request_id
   AND r.state=NEW.from_state AND NEW.to_state IN ('INVESTIGATING','WAITING_ON_CUSTOMER','CLOSED')) THEN
   RAISE EXCEPTION 'invalid closure state history' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.gphkm_finalize_organization_closure(target_request text, target_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org_id text; current_state text;
BEGIN
 SELECT organization_id,state INTO org_id,current_state FROM public.organization_closure_request WHERE id=target_request FOR UPDATE;
 IF org_id IS NULL OR current_state NOT IN ('OPEN','INVESTIGATING','WAITING_ON_CUSTOMER')
   OR target_actor IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')
   OR NOT (public.gphkm_is_active_staff(target_actor,'ADMIN') OR public.gphkm_is_active_staff(target_actor,'SUPER_ADMIN')) THEN
   RAISE EXCEPTION 'closure request unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.organization WHERE id=org_id FOR UPDATE;
 IF cardinality(public.gphkm_closure_blockers(org_id))>0 THEN RAISE EXCEPTION 'organization closure blockers remain' USING ERRCODE='23514'; END IF;
 UPDATE public.organization SET closed_at=clock_timestamp() WHERE id=org_id AND closed_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'organization already closed' USING ERRCODE='23514'; END IF;
 UPDATE public.organization_member SET active=false WHERE organization_id=org_id AND active;
 UPDATE public.organization_invitation SET status='REVOKED',revoked_at=clock_timestamp()
   WHERE organization_id=org_id AND status='PENDING';
END $$;
