CREATE TABLE "supplier_fulfillment_recovery" (
	"id" text PRIMARY KEY NOT NULL,
	"order_item_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"support_case_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"route_generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_fulfillment_recovery_idem_uq" UNIQUE("order_item_id","actor_user_id","idempotency_key"),
	CONSTRAINT "supplier_fulfillment_recovery_reason_valid" CHECK (length(btrim("supplier_fulfillment_recovery"."reason")) between 5 and 2000),
	CONSTRAINT "supplier_fulfillment_recovery_identity_valid" CHECK (length("supplier_fulfillment_recovery"."idempotency_key") between 16 and 128 and "supplier_fulfillment_recovery"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "supplier_fulfillment_recovery_route_generation_positive" CHECK ("supplier_fulfillment_recovery"."route_generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "supplier_fulfillment_recovery" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_fulfillment_outcome_resolution" ALTER COLUMN "offer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_fulfillment_outcome_resolution" ADD COLUMN "recovery_id" text;--> statement-breakpoint
ALTER TABLE "supplier_fulfillment_recovery" ADD CONSTRAINT "supplier_fulfillment_recovery_order_item_id_customer_order_item_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."customer_order_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_fulfillment_recovery" ADD CONSTRAINT "supplier_fulfillment_recovery_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_fulfillment_recovery" ADD CONSTRAINT "supplier_fulfillment_recovery_support_case_id_support_case_id_fk" FOREIGN KEY ("support_case_id") REFERENCES "public"."support_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_fulfillment_recovery" ADD CONSTRAINT "supplier_fulfillment_recovery_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_fulfillment_recovery_item_idx" ON "supplier_fulfillment_recovery" USING btree ("order_item_id","created_at");--> statement-breakpoint
ALTER TABLE "supplier_fulfillment_outcome_resolution" ADD CONSTRAINT "supplier_fulfillment_outcome_resolution_recovery_id_supplier_fulfillment_recovery_id_fk" FOREIGN KEY ("recovery_id") REFERENCES "public"."supplier_fulfillment_recovery"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_fulfillment_outcome_resolution_recovery_idx" ON "supplier_fulfillment_outcome_resolution" USING btree ("recovery_id");--> statement-breakpoint
ALTER TABLE "supplier_fulfillment_outcome_resolution" ADD CONSTRAINT "supplier_fulfillment_outcome_resolution_method_valid" CHECK (("supplier_fulfillment_outcome_resolution"."offer_id" is not null and "supplier_fulfillment_outcome_resolution"."recovery_id" is null) or ("supplier_fulfillment_outcome_resolution"."offer_id" is null and "supplier_fulfillment_outcome_resolution"."recovery_id" is not null));
--> statement-breakpoint

REVOKE ALL ON public.supplier_fulfillment_recovery FROM PUBLIC, gphkm_runtime;--> statement-breakpoint
GRANT SELECT ON public.supplier_fulfillment_recovery TO gphkm_runtime;--> statement-breakpoint
CREATE POLICY supplier_fulfillment_recovery_assigned_read ON public.supplier_fulfillment_recovery FOR SELECT TO gphkm_runtime USING (
  public.gphkm_staff_can_read_order_item(order_item_id, nullif(current_setting('app.user_id', true), ''))
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_reject_supplier_recovery_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'supplier recovery history is append-only' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_reject_supplier_recovery_mutation() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER supplier_fulfillment_recovery_append_only
  BEFORE UPDATE OR DELETE ON public.supplier_fulfillment_recovery
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_supplier_recovery_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_recover_supplier_failure(
  target_item_id text, target_reason text, target_idempotency_key text, target_request_hash text
) RETURNS TABLE(recovery_id text, support_case_id text, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  actor_role text;
  actor_active boolean;
  order_id text;
  organization_id text;
  current_state text;
  assignee_id text;
  state_before_hold text;
  state_before_cancellation text;
  handed_off_at timestamptz;
  work_started_at timestamptz;
  current_supplier_id text;
  current_route_generation integer;
  failed_case_id text;
  failed_case_order_id text;
  failed_case_state text;
  failed_case_merged_into text;
  existing_id text;
  existing_case_id text;
  next_recovery_id text;
  resolved_count integer;
BEGIN
  IF actor_id IS NULL OR target_item_id IS NULL OR target_item_id !~ '^[0-9a-f-]{36}$'
     OR target_idempotency_key IS NULL OR target_idempotency_key !~ '^[0-9a-f-]{36}$'
     OR target_request_hash IS NULL OR target_request_hash !~ '^[0-9a-f]{64}$'
     OR target_reason IS NULL OR length(btrim(target_reason)) NOT BETWEEN 5 AND 2000
     OR target_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'supplier recovery is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT staff.role, staff.active INTO actor_role, actor_active
    FROM public.staff_account staff WHERE staff.user_id = actor_id FOR SHARE;
  IF NOT FOUND OR NOT actor_active OR actor_role <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'supplier recovery requires an active Super Admin' USING ERRCODE = '42501';
  END IF;

  SELECT ord.id, ord.organization_id INTO order_id, organization_id
    FROM public.customer_order_item item JOIN public.customer_order ord ON ord.id = item.order_id
   WHERE item.id = target_item_id AND ord.checkout_state = 'PAID';
  IF NOT FOUND THEN RAISE EXCEPTION 'supplier recovery item is unavailable' USING ERRCODE = '42501'; END IF;

  -- Share the same order-scoped serialization used by supplier outcome and
  -- Support commands, then lock item → route → case (the offer-acceptance order).
  PERFORM pg_advisory_xact_lock(hashtextextended('gphkm:support-order:' || organization_id || ':' || order_id, 0));
  SELECT fulfillment.state, fulfillment.assigned_admin_id, fulfillment.state_before_hold,
         fulfillment.state_before_cancellation, fulfillment.handed_off_at, fulfillment.work_started_at
    INTO current_state, assignee_id, state_before_hold, state_before_cancellation, handed_off_at, work_started_at
    FROM public.order_item_fulfillment fulfillment
   WHERE fulfillment.order_item_id = target_item_id FOR UPDATE;
  IF NOT FOUND OR current_state <> 'ON_HOLD' OR assignee_id IS DISTINCT FROM actor_id
     OR state_before_hold IS NULL OR state_before_cancellation IS NOT NULL
     OR handed_off_at IS NOT NULL OR work_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'supplier recovery requires the assigned Super Admin and an unhanded-off item on hold' USING ERRCODE = '42501';
  END IF;

  SELECT recovery.id, recovery.support_case_id INTO existing_id, existing_case_id
    FROM public.supplier_fulfillment_recovery recovery
   WHERE recovery.order_item_id = target_item_id AND recovery.actor_user_id = actor_id
     AND recovery.idempotency_key = target_idempotency_key;
  IF existing_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.supplier_fulfillment_recovery recovery
        WHERE recovery.id = existing_id AND recovery.request_hash = target_request_hash) THEN
      RAISE EXCEPTION 'supplier recovery idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing_id, existing_case_id, true;
    RETURN;
  END IF;

  SELECT route.supplier_id, route.route_generation
    INTO current_supplier_id, current_route_generation
    FROM public.order_item_fulfillment_supplier route
   WHERE route.order_item_id = target_item_id FOR UPDATE;
  IF NOT FOUND OR current_supplier_id IS NULL OR current_route_generation < 1
     OR NOT EXISTS (SELECT 1 FROM public.supplier supplier
       WHERE supplier.id = current_supplier_id AND supplier.status = 'ACTIVE')
     OR NOT EXISTS (SELECT 1 FROM public.supplier_contact contact
       WHERE contact.supplier_id = current_supplier_id AND contact.is_primary) THEN
    RAISE EXCEPTION 'current supplier or primary recipient is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT min(outcome.support_case_id) INTO failed_case_id
    FROM public.supplier_fulfillment_outcome outcome
   WHERE outcome.order_item_id = target_item_id
     AND outcome.supplier_id = current_supplier_id
     AND outcome.route_generation = current_route_generation
     AND NOT EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome_resolution resolution
       WHERE resolution.outcome_id = outcome.id);
  IF failed_case_id IS NULL OR EXISTS (
    SELECT 1 FROM public.supplier_fulfillment_outcome outcome
     WHERE outcome.order_item_id = target_item_id
       AND NOT EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome_resolution resolution
         WHERE resolution.outcome_id = outcome.id)
       AND (outcome.supplier_id IS DISTINCT FROM current_supplier_id
         OR outcome.route_generation <> current_route_generation
         OR outcome.support_case_id IS DISTINCT FROM failed_case_id)
  ) THEN
    RAISE EXCEPTION 'unresolved supplier failure does not match the current supplier route' USING ERRCODE = '42501';
  END IF;

  SELECT support.order_id, support.state, support.merged_into_case_id
    INTO failed_case_order_id, failed_case_state, failed_case_merged_into
    FROM public.support_case support WHERE support.id = failed_case_id FOR UPDATE;
  IF NOT FOUND OR failed_case_order_id IS DISTINCT FROM order_id
     OR failed_case_state IN ('RESOLVED', 'CLOSED') OR failed_case_merged_into IS NOT NULL THEN
    RAISE EXCEPTION 'same-supplier recovery requires the active order Support case' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT ON (event.offer_id) event.event_type
        FROM public.order_item_equivalent_offer_event event
        JOIN public.order_item_equivalent_offer offer ON offer.id = event.offer_id
       WHERE offer.order_item_id = target_item_id
       ORDER BY event.offer_id, event.created_at DESC, event.id DESC
    ) latest WHERE latest.event_type = 'OFFERED'
  ) THEN
    RAISE EXCEPTION 'resolve the pending equivalent offer before same-supplier recovery' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.supplier_packet_item packet_item
    JOIN public.supplier_packet_attempt attempt ON attempt.packet_id = packet_item.packet_id
    WHERE packet_item.order_item_id = target_item_id
  ) THEN
    RAISE EXCEPTION 'reconcile prior packet attempts before same-supplier recovery' USING ERRCODE = '42501';
  END IF;

  next_recovery_id := gen_random_uuid()::text;
  INSERT INTO public.supplier_fulfillment_recovery (
    id, order_item_id, supplier_id, support_case_id, actor_user_id, reason,
    idempotency_key, request_hash, route_generation
  ) VALUES (
    next_recovery_id, target_item_id, current_supplier_id, failed_case_id, actor_id,
    btrim(target_reason), target_idempotency_key, target_request_hash, current_route_generation
  );

  INSERT INTO public.supplier_fulfillment_outcome_resolution (outcome_id, offer_id, recovery_id, resolved_at)
  SELECT outcome.id, NULL, next_recovery_id, clock_timestamp()
    FROM public.supplier_fulfillment_outcome outcome
   WHERE outcome.order_item_id = target_item_id
     AND outcome.supplier_id = current_supplier_id
     AND outcome.support_case_id = failed_case_id
     AND outcome.route_generation = current_route_generation
     AND NOT EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome_resolution resolution
       WHERE resolution.outcome_id = outcome.id);
  GET DIAGNOSTICS resolved_count = ROW_COUNT;
  IF resolved_count = 0 THEN RAISE EXCEPTION 'supplier failure recovery requires reconciliation' USING ERRCODE = '42501'; END IF;

  RETURN QUERY SELECT next_recovery_id, failed_case_id, false;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_recover_supplier_failure(text, text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_recover_supplier_failure(text, text, text, text) TO gphkm_runtime;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_block_equivalent_offer_after_recovery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.event_type = 'OFFERED' AND EXISTS (
    SELECT 1 FROM public.order_item_equivalent_offer offer
    JOIN public.order_item_fulfillment_supplier route ON route.order_item_id = offer.order_item_id
    JOIN public.supplier_fulfillment_outcome outcome ON outcome.order_item_id = offer.order_item_id
      AND outcome.support_case_id = offer.support_case_id
      AND outcome.supplier_id = route.supplier_id
      AND outcome.route_generation = route.route_generation
    JOIN public.supplier_fulfillment_outcome_resolution resolution ON resolution.outcome_id = outcome.id
    WHERE offer.id = NEW.offer_id
  ) THEN
    RAISE EXCEPTION 'cannot offer a replacement after the current supplier failure has been resolved' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_block_equivalent_offer_after_recovery() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER equivalent_offer_reject_resolved_supplier_failure
  BEFORE INSERT ON public.order_item_equivalent_offer_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_block_equivalent_offer_after_recovery();--> statement-breakpoint

-- Attempts require a current resolved failure provenance and a resumed item.
-- The row lock also serializes attempts against recovery and fulfillment holds.
CREATE OR REPLACE FUNCTION public.gphkm_packet_attempt_route_generation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  packet_row public.supplier_packet%ROWTYPE;
  item_ref text;
  item_state text;
  item_route_supplier_id text;
  item_route_generation integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.type NOT IN ('SEND','EML_EXPORT','PDF_EXPORT','MANUAL_SENT','MANUAL_SEND') THEN RETURN NEW; END IF;
  SELECT packet.* INTO packet_row FROM public.supplier_packet packet WHERE packet.id = NEW.packet_id FOR UPDATE;
  IF NOT FOUND OR packet_row.superseded_at IS NOT NULL OR packet_row.hold_reason IS NOT NULL THEN
    RAISE EXCEPTION 'supplier packet is superseded, held, or unavailable' USING ERRCODE = '42501';
  END IF;

  FOR item_ref IN
    SELECT packet_item.order_item_id FROM public.supplier_packet_item packet_item
     WHERE packet_item.packet_id = NEW.packet_id ORDER BY packet_item.order_item_id
  LOOP
    SELECT fulfillment.state INTO item_state
      FROM public.order_item_fulfillment fulfillment
     WHERE fulfillment.order_item_id = item_ref FOR UPDATE;
    IF item_state NOT IN ('HANDOFF_PENDING', 'IN_FULFILLMENT') THEN
      RAISE EXCEPTION 'supplier packet attempts require an active handoff item' USING ERRCODE = '42501';
    END IF;
    SELECT route.supplier_id, route.route_generation INTO item_route_supplier_id, item_route_generation
      FROM public.order_item_fulfillment_supplier route
     WHERE route.order_item_id = item_ref FOR KEY SHARE;
    IF item_route_supplier_id IS DISTINCT FROM packet_row.supplier_id OR NOT EXISTS (
      SELECT 1 FROM public.supplier_packet_item packet_item
      JOIN public.supplier_packet packet ON packet.id = packet_item.packet_id
      JOIN public.supplier_contact contact ON contact.supplier_id = packet.supplier_id AND contact.is_primary
       WHERE packet_item.packet_id = NEW.packet_id AND packet_item.order_item_id = item_ref
         AND packet_item.route_generation = item_route_generation
         AND packet.version = (SELECT max(latest.version)
           FROM public.supplier_packet latest
           JOIN public.supplier_packet_item latest_item ON latest_item.packet_id = latest.id
           WHERE latest_item.order_item_id = item_ref AND latest_item.route_generation = item_route_generation
             AND latest.supplier_id = item_route_supplier_id AND latest.superseded_at IS NULL AND latest.hold_reason IS NULL)
         AND lower(contact.email) = lower(packet.recipient)
    ) THEN
      RAISE EXCEPTION 'supplier packet route, recipient, or active version is stale' USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.supplier_fulfillment_outcome outcome
       WHERE outcome.order_item_id = item_ref
         AND NOT EXISTS (
           SELECT 1 FROM public.supplier_fulfillment_outcome_resolution resolution
            WHERE resolution.outcome_id = outcome.id
              AND (
                (resolution.offer_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM public.order_item_equivalent_offer offer
                  JOIN public.order_item_equivalent_offer_route offer_route ON offer_route.offer_id = offer.id
                  JOIN public.customer_order_item item ON item.id = offer.order_item_id
                  JOIN public.customer_order order_row ON order_row.id = item.order_id
                  JOIN LATERAL (
                    SELECT event.event_type, event.actor_user_id
                      FROM public.order_item_equivalent_offer_event event
                     WHERE event.offer_id = offer.id ORDER BY event.created_at DESC, event.id DESC LIMIT 1
                  ) latest ON true
                  WHERE offer.id = resolution.offer_id AND offer.order_item_id = outcome.order_item_id
                    AND offer.support_case_id = outcome.support_case_id AND latest.event_type = 'ACCEPTED'
                    AND latest.actor_user_id = order_row.actor_user_id
                    AND offer_route.route_generation > outcome.route_generation
                    AND offer_route.route_generation <= item_route_generation
                ))
                OR (resolution.recovery_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM public.supplier_fulfillment_recovery recovery
                  WHERE recovery.id = resolution.recovery_id AND recovery.order_item_id = outcome.order_item_id
                    AND recovery.supplier_id = outcome.supplier_id
                    AND recovery.support_case_id = outcome.support_case_id
                    AND recovery.route_generation = outcome.route_generation
                    AND recovery.route_generation <= item_route_generation
                ))
              )
         )
    ) THEN
      RAISE EXCEPTION 'resolve the supplier failure through an accepted route or audited recovery before handoff' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.supplier_packet_item packet_item WHERE packet_item.packet_id = NEW.packet_id) THEN
    RAISE EXCEPTION 'supplier packet has no items' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_packet_attempt_route_generation_guard() FROM PUBLIC;
