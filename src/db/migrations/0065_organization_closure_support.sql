CREATE TABLE "organization_closure_event" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_kind" text NOT NULL,
	"kind" text NOT NULL,
	"audience" text NOT NULL,
	"body" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_closure_event_idem_uq" UNIQUE("request_id","actor_user_id","idempotency_key"),
	CONSTRAINT "organization_closure_event_actor_valid" CHECK ("organization_closure_event"."actor_kind" in ('CUSTOMER','STAFF')),
	CONSTRAINT "organization_closure_event_kind_valid" CHECK ("organization_closure_event"."kind" in ('OPENED','STATE_CHANGED','REPLY','NOTE')),
	CONSTRAINT "organization_closure_event_audience_valid" CHECK ("organization_closure_event"."audience" in ('CUSTOMER','INTERNAL')),
	CONSTRAINT "organization_closure_event_body_valid" CHECK (length(trim("organization_closure_event"."body")) between 1 and 4000),
	CONSTRAINT "organization_closure_event_idem_valid" CHECK (length("organization_closure_event"."idempotency_key") between 16 and 128 and "organization_closure_event"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "organization_closure_event_state_shape" CHECK (("organization_closure_event"."kind" = 'OPENED' and "organization_closure_event"."from_state" is null and "organization_closure_event"."to_state" = 'OPEN') or ("organization_closure_event"."kind" = 'STATE_CHANGED' and "organization_closure_event"."from_state" is not null and "organization_closure_event"."to_state" is not null) or ("organization_closure_event"."kind" in ('REPLY','NOTE') and "organization_closure_event"."from_state" is null and "organization_closure_event"."to_state" is null)),
	CONSTRAINT "organization_closure_event_opened_shape" CHECK ("organization_closure_event"."kind" <> 'OPENED' or ("organization_closure_event"."actor_kind" = 'CUSTOMER' and "organization_closure_event"."audience" = 'CUSTOMER')),
	CONSTRAINT "organization_closure_event_reply_shape" CHECK ("organization_closure_event"."kind" <> 'REPLY' or ("organization_closure_event"."actor_kind" in ('CUSTOMER','STAFF') and "organization_closure_event"."audience" = 'CUSTOMER')),
	CONSTRAINT "organization_closure_event_note_shape" CHECK ("organization_closure_event"."kind" <> 'NOTE' or ("organization_closure_event"."actor_kind" = 'STAFF' and "organization_closure_event"."audience" = 'INTERNAL'))
);
--> statement-breakpoint
ALTER TABLE "organization_closure_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_closure_request" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"opened_by_user_id" text NOT NULL,
	"summary" text NOT NULL,
	"state" text DEFAULT 'OPEN' NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" text,
	CONSTRAINT "organization_closure_request_opener_idem_uq" UNIQUE("organization_id","opened_by_user_id","idempotency_key"),
	CONSTRAINT "organization_closure_request_state_valid" CHECK ("organization_closure_request"."state" in ('OPEN','INVESTIGATING','WAITING_ON_CUSTOMER','CLOSED')),
	CONSTRAINT "organization_closure_request_summary_valid" CHECK (length(trim("organization_closure_request"."summary")) between 5 and 2000),
	CONSTRAINT "organization_closure_request_idem_valid" CHECK (length("organization_closure_request"."idempotency_key") between 16 and 128 and "organization_closure_request"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "organization_closure_request_closed_shape" CHECK (("organization_closure_request"."state" = 'CLOSED' and "organization_closure_request"."closed_at" is not null and "organization_closure_request"."closed_by_user_id" is not null) or ("organization_closure_request"."state" <> 'CLOSED' and "organization_closure_request"."closed_at" is null and "organization_closure_request"."closed_by_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "organization_closure_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_closure_event" ADD CONSTRAINT "organization_closure_event_request_id_organization_closure_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."organization_closure_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_closure_event" ADD CONSTRAINT "organization_closure_event_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_closure_request" ADD CONSTRAINT "organization_closure_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_closure_request" ADD CONSTRAINT "organization_closure_request_opened_by_user_id_auth_user_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_closure_request" ADD CONSTRAINT "organization_closure_request_closed_by_user_id_auth_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE organization_closure_event ADD CONSTRAINT organization_closure_event_state_shape_actor CHECK (kind <> 'STATE_CHANGED' OR (actor_kind='STAFF' AND audience IN ('CUSTOMER','INTERNAL')));--> statement-breakpoint
CREATE INDEX "organization_closure_event_history_idx" ON "organization_closure_event" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_closure_request_one_active_uq" ON "organization_closure_request" USING btree ("organization_id") WHERE "organization_closure_request"."state" <> 'CLOSED';--> statement-breakpoint
CREATE INDEX "organization_closure_request_state_updated_idx" ON "organization_closure_request" USING btree ("state","updated_at");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON organization_closure_request TO gphkm_runtime;
GRANT SELECT, INSERT ON organization_closure_event TO gphkm_runtime;
REVOKE DELETE ON organization_closure_request FROM gphkm_runtime;
REVOKE UPDATE, DELETE ON organization_closure_event FROM gphkm_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.gphkm_is_active_org_member(target_org text, target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organization_member m JOIN public.organization o ON o.id=m.organization_id
    WHERE m.organization_id=target_org AND m.user_id=target_user AND m.active AND o.closed_at IS NULL)
$$;
CREATE OR REPLACE FUNCTION public.gphkm_is_active_org_owner(target_org text, target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organization_member m JOIN public.organization o ON o.id=m.organization_id
    WHERE m.organization_id=target_org AND m.user_id=target_user AND m.active AND m.role='OWNER' AND o.closed_at IS NULL)
$$;
--> statement-breakpoint
CREATE FUNCTION public.gphkm_closure_staff_access(target_request text, target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_is_active_staff(target_user,'SUPER_ADMIN') OR public.gphkm_is_active_staff(target_user,'ADMIN')
$$;
CREATE FUNCTION public.gphkm_closure_owner_access(target_request text, target_user text, target_org text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organization_closure_request r
    JOIN public.organization o ON o.id=r.organization_id
    WHERE r.id=target_request AND r.organization_id=target_org AND (
      public.gphkm_is_active_org_owner(target_org,target_user)
      OR (r.opened_by_user_id=target_user AND o.closed_at IS NOT NULL)))
$$;
REVOKE ALL ON FUNCTION public.gphkm_closure_staff_access(text,text), public.gphkm_closure_owner_access(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_closure_staff_access(text,text), public.gphkm_closure_owner_access(text,text,text) TO gphkm_runtime;
--> statement-breakpoint
CREATE POLICY organization_closure_customer_read ON organization_closure_request FOR SELECT TO gphkm_runtime
  USING (public.gphkm_closure_owner_access(id,nullif(current_setting('app.user_id',true),''),nullif(current_setting('app.organization_id',true),'')));
CREATE POLICY organization_closure_customer_open ON organization_closure_request FOR INSERT TO gphkm_runtime
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')
    AND opened_by_user_id=nullif(current_setting('app.user_id',true),'') AND state='OPEN'
    AND public.gphkm_is_active_org_owner(organization_id,opened_by_user_id));
CREATE POLICY organization_closure_staff_read ON organization_closure_request FOR SELECT TO gphkm_runtime
  USING (public.gphkm_closure_staff_access(id,nullif(current_setting('app.user_id',true),'')));
CREATE POLICY organization_closure_staff_update ON organization_closure_request FOR UPDATE TO gphkm_runtime
  USING (public.gphkm_closure_staff_access(id,nullif(current_setting('app.user_id',true),'')))
  WITH CHECK (public.gphkm_closure_staff_access(id,nullif(current_setting('app.user_id',true),'')));
CREATE POLICY organization_closure_event_customer_read ON organization_closure_event FOR SELECT TO gphkm_runtime
  USING (audience='CUSTOMER' AND public.gphkm_closure_owner_access(request_id,nullif(current_setting('app.user_id',true),''),nullif(current_setting('app.organization_id',true),'')));
CREATE POLICY organization_closure_event_staff_read ON organization_closure_event FOR SELECT TO gphkm_runtime
  USING (public.gphkm_closure_staff_access(request_id,nullif(current_setting('app.user_id',true),'')));
CREATE POLICY organization_closure_event_customer_insert ON organization_closure_event FOR INSERT TO gphkm_runtime
  WITH CHECK (actor_kind='CUSTOMER' AND audience='CUSTOMER' AND actor_user_id=nullif(current_setting('app.user_id',true),'')
    AND kind IN ('OPENED','REPLY')
    AND public.gphkm_closure_owner_access(request_id,actor_user_id,nullif(current_setting('app.organization_id',true),'')));
CREATE POLICY organization_closure_event_staff_insert ON organization_closure_event FOR INSERT TO gphkm_runtime
  WITH CHECK (actor_kind='STAFF' AND actor_user_id=nullif(current_setting('app.user_id',true),'')
    AND kind IN ('STATE_CHANGED','REPLY','NOTE')
    AND public.gphkm_closure_staff_access(request_id,actor_user_id));
--> statement-breakpoint
CREATE FUNCTION public.gphkm_closure_blockers(target_org text) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 SELECT array_remove(ARRAY[
   CASE WHEN coalesce((SELECT balance_minor FROM public.wallet_account WHERE organization_id=target_org),0) <> 0 THEN 'WALLET_BALANCE' END,
   CASE WHEN EXISTS (SELECT 1 FROM public.customer_order o LEFT JOIN public.order_item_fulfillment f ON f.order_id=o.id
     WHERE o.organization_id=target_org AND (o.checkout_state='PENDING_POST' OR (f.state IS NOT NULL AND f.state NOT IN ('COMPLETED','CANCELED_REFUNDED')))) THEN 'ACTIVE_ORDERS' END,
   CASE WHEN EXISTS (SELECT 1 FROM public.stripe_reconciliation_case WHERE organization_id=target_org AND state='OPEN') THEN 'OPEN_STRIPE_CASES' END,
   CASE WHEN EXISTS (SELECT 1 FROM public.support_case WHERE organization_id=target_org AND state NOT IN ('RESOLVED','CLOSED')) THEN 'OPEN_SUPPORT_CASES' END,
   CASE WHEN EXISTS (SELECT 1 FROM public.payment_attempt WHERE organization_id=target_org AND state IN ('CREATED','PENDING','DISPUTED')) THEN 'UNRESOLVED_PAYMENTS' END
 ],NULL)
$$;
REVOKE ALL ON FUNCTION public.gphkm_closure_blockers(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_closure_blockers(text) TO gphkm_runtime;
--> statement-breakpoint
CREATE FUNCTION public.gphkm_closure_request_guard() RETURNS trigger
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
      OR NOT public.gphkm_is_active_staff(actor_id,'ADMIN') AND NOT public.gphkm_is_active_staff(actor_id,'SUPER_ADMIN')) THEN
     RAISE EXCEPTION 'organization closure blockers remain' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER organization_closure_request_guard BEFORE INSERT OR UPDATE ON organization_closure_request
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_closure_request_guard();
CREATE FUNCTION public.gphkm_closure_event_guard() RETURNS trigger
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
CREATE TRIGGER organization_closure_event_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_closure_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_closure_event_guard();
CREATE FUNCTION public.gphkm_closure_touch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN UPDATE public.organization_closure_request SET updated_at=clock_timestamp() WHERE id=NEW.request_id; RETURN NEW; END $$;
CREATE TRIGGER organization_closure_event_touch AFTER INSERT ON organization_closure_event FOR EACH ROW EXECUTE FUNCTION public.gphkm_closure_touch();
--> statement-breakpoint
CREATE FUNCTION public.gphkm_guard_open_organization() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org_id text; closed timestamptz;
BEGIN
 org_id:=CASE WHEN TG_TABLE_NAME='customer_order' THEN NEW.organization_id ELSE NEW.organization_id END;
 SELECT closed_at INTO closed FROM public.organization WHERE id=org_id FOR SHARE;
 IF NOT FOUND OR closed IS NOT NULL THEN RAISE EXCEPTION 'organization is closed' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER organization_member_open_guard BEFORE INSERT ON organization_member FOR EACH ROW EXECUTE FUNCTION public.gphkm_guard_open_organization();
CREATE TRIGGER organization_invitation_open_guard BEFORE INSERT ON organization_invitation FOR EACH ROW EXECUTE FUNCTION public.gphkm_guard_open_organization();
CREATE TRIGGER customer_order_open_guard BEFORE INSERT ON customer_order FOR EACH ROW EXECUTE FUNCTION public.gphkm_guard_open_organization();
CREATE TRIGGER payment_attempt_open_guard BEFORE INSERT ON payment_attempt FOR EACH ROW EXECUTE FUNCTION public.gphkm_guard_open_organization();
--> statement-breakpoint
CREATE FUNCTION public.gphkm_finalize_organization_closure(target_request text, target_actor text) RETURNS void
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
REVOKE ALL ON FUNCTION public.gphkm_finalize_organization_closure(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_finalize_organization_closure(text,text) TO gphkm_runtime;
