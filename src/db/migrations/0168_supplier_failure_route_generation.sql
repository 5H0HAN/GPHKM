CREATE TABLE "supplier_fulfillment_outcome_resolution" (
	"outcome_id" text PRIMARY KEY NOT NULL,
	"offer_id" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_fulfillment_outcome_resolution" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_fulfillment_outcome" ADD COLUMN "route_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_fulfillment_outcome_resolution" ADD CONSTRAINT "supplier_fulfillment_outcome_resolution_outcome_id_supplier_fulfillment_outcome_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."supplier_fulfillment_outcome"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_fulfillment_outcome_resolution" ADD CONSTRAINT "supplier_fulfillment_outcome_resolution_offer_id_order_item_equivalent_offer_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."order_item_equivalent_offer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_fulfillment_outcome_resolution_offer_idx" ON "supplier_fulfillment_outcome_resolution" USING btree ("offer_id");--> statement-breakpoint
ALTER TABLE "supplier_fulfillment_outcome" ADD CONSTRAINT "supplier_fulfillment_outcome_route_generation_positive" CHECK ("supplier_fulfillment_outcome"."route_generation" > 0);
--> statement-breakpoint

REVOKE ALL ON public.supplier_fulfillment_outcome_resolution FROM PUBLIC, gphkm_runtime;--> statement-breakpoint
GRANT SELECT ON public.supplier_fulfillment_outcome_resolution TO gphkm_runtime;--> statement-breakpoint
CREATE POLICY supplier_failure_resolution_assigned_read ON public.supplier_fulfillment_outcome_resolution FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome
    WHERE outcome.id = supplier_fulfillment_outcome_resolution.outcome_id
      AND public.gphkm_staff_can_read_order_item(outcome.order_item_id, nullif(current_setting('app.user_id',true),'')))
);--> statement-breakpoint

-- App timestamps cannot reliably order old outcomes against accepted offers.
-- Reconstruct only histories proven by the immutable checkout supplier and the
-- accepted-event count: current-source failures belong to the current route;
-- an A checkout-source failure belongs to generation 1 after one A→B acceptance.
-- Migration 0162 left already-accepted routes at generation 1, so support both
-- that exact legacy shape and the generation-2 shape created by later code.
-- The outcomes are immutable during application use; this migration-only
-- baseline update is the sole exception and the append-only guard is restored.
ALTER TABLE public.supplier_fulfillment_outcome DISABLE TRIGGER supplier_fulfillment_outcome_append_only;--> statement-breakpoint
WITH accepted_counts AS (
  SELECT offer.order_item_id, count(*)::integer AS accepted_count
    FROM public.order_item_equivalent_offer offer
    JOIN public.order_item_equivalent_offer_event event ON event.offer_id = offer.id
   WHERE event.event_type = 'ACCEPTED'
   GROUP BY offer.order_item_id
)
UPDATE public.supplier_fulfillment_outcome outcome
   SET route_generation = CASE
     WHEN outcome.supplier_id = current_route.supplier_id THEN current_route.route_generation
     WHEN current_route.route_generation IN (1, 2) AND coalesce(accepted_counts.accepted_count, 0) = 1
       AND outcome.supplier_id = financial.fulfillment_supplier_id THEN 1
     ELSE outcome.route_generation
   END
  FROM public.order_item_fulfillment_supplier current_route
  JOIN public.order_item_financial financial ON financial.order_item_id = current_route.order_item_id
  LEFT JOIN accepted_counts ON accepted_counts.order_item_id = current_route.order_item_id
 WHERE current_route.order_item_id = outcome.order_item_id;--> statement-breakpoint
ALTER TABLE public.supplier_fulfillment_outcome ENABLE TRIGGER supplier_fulfillment_outcome_append_only;--> statement-breakpoint

INSERT INTO public.supplier_fulfillment_outcome_resolution (outcome_id, offer_id, resolved_at)
SELECT outcome.id, offer.id, clock_timestamp()
  FROM public.supplier_fulfillment_outcome outcome
  JOIN public.customer_order_item item ON item.id = outcome.order_item_id
  JOIN public.customer_order ord ON ord.id = item.order_id
  JOIN public.order_item_financial financial ON financial.order_item_id = outcome.order_item_id
  JOIN public.order_item_fulfillment_supplier current_route ON current_route.order_item_id = outcome.order_item_id
  JOIN public.order_item_equivalent_offer offer
    ON offer.id = current_route.last_equivalent_offer_id
   AND offer.order_item_id = outcome.order_item_id
   AND offer.support_case_id = outcome.support_case_id
  JOIN public.order_item_equivalent_offer_route offer_route
    ON offer_route.offer_id = offer.id
   AND offer_route.supplier_id = current_route.supplier_id
   AND offer_route.route_generation = current_route.route_generation
  JOIN LATERAL (
    SELECT event.event_type, event.actor_user_id
      FROM public.order_item_equivalent_offer_event event
     WHERE event.offer_id = offer.id
     ORDER BY event.created_at DESC, event.id DESC LIMIT 1
  ) latest ON latest.event_type = 'ACCEPTED' AND latest.actor_user_id = ord.actor_user_id
 WHERE outcome.supplier_id IS DISTINCT FROM current_route.supplier_id
   AND outcome.supplier_id = financial.fulfillment_supplier_id
   AND current_route.route_generation IN (1, 2)
   AND outcome.route_generation = 1
   AND 1 = (
     SELECT count(*)
       FROM public.order_item_equivalent_offer accepted_offer
       JOIN public.order_item_equivalent_offer_event accepted_event ON accepted_event.offer_id = accepted_offer.id
      WHERE accepted_offer.order_item_id = outcome.order_item_id
        AND accepted_event.event_type = 'ACCEPTED'
   )
ON CONFLICT (outcome_id) DO NOTHING;--> statement-breakpoint

-- A historical outcome that cannot be linked from current route evidence has
-- no safe recovery path after terminal closure, a missing fulfillment route,
-- or a source/current mismatch. Multiple accepted route changes can also
-- return to the same supplier, so supplier equality alone cannot prove which
-- generation failed. Stop so an operator can reconcile ambiguous history.
DO $$
DECLARE unresolved_count bigint;
BEGIN
  WITH accepted_counts AS (
    SELECT offer.order_item_id, count(*)::integer AS accepted_count
      FROM public.order_item_equivalent_offer offer
      JOIN public.order_item_equivalent_offer_event event ON event.offer_id = offer.id
     WHERE event.event_type = 'ACCEPTED'
     GROUP BY offer.order_item_id
  )
  SELECT count(*) INTO unresolved_count
    FROM public.supplier_fulfillment_outcome outcome
    JOIN public.support_case case_row ON case_row.id = outcome.support_case_id
    JOIN public.customer_order_item item ON item.id = outcome.order_item_id
    JOIN public.customer_order ord ON ord.id = item.order_id
    LEFT JOIN public.order_item_fulfillment fulfillment ON fulfillment.order_item_id = outcome.order_item_id
    LEFT JOIN public.order_item_fulfillment_supplier current_route ON current_route.order_item_id = outcome.order_item_id
    LEFT JOIN accepted_counts ON accepted_counts.order_item_id = outcome.order_item_id
   WHERE (fulfillment.order_item_id IS NULL OR (fulfillment.state <> 'CANCELED_REFUNDED'
     AND (case_row.state IN ('RESOLVED','CLOSED')
       OR fulfillment.state = 'COMPLETED'
       OR current_route.supplier_id IS NULL
       OR outcome.supplier_id IS DISTINCT FROM current_route.supplier_id
       OR current_route.route_generation <> 1 + coalesce(accepted_counts.accepted_count, 0)
          AND NOT (
            current_route.route_generation = 1 AND accepted_counts.accepted_count = 1
            AND EXISTS (
              SELECT 1 FROM public.order_item_equivalent_offer legacy_offer
              JOIN public.order_item_equivalent_offer_route legacy_route ON legacy_route.offer_id = legacy_offer.id
              JOIN LATERAL (
                SELECT event.event_type, event.actor_user_id
                  FROM public.order_item_equivalent_offer_event event
                 WHERE event.offer_id = legacy_offer.id
                 ORDER BY event.created_at DESC, event.id DESC LIMIT 1
              ) latest ON latest.event_type = 'ACCEPTED' AND latest.actor_user_id = ord.actor_user_id
             WHERE legacy_offer.id = current_route.last_equivalent_offer_id
               AND legacy_offer.order_item_id = outcome.order_item_id
               AND legacy_route.supplier_id = current_route.supplier_id
               AND legacy_route.route_generation = 1
            )
          )
       OR accepted_counts.accepted_count > 1)))
     AND NOT EXISTS (
       SELECT 1 FROM public.supplier_fulfillment_outcome_resolution resolution
        WHERE resolution.outcome_id = outcome.id
     );
  IF unresolved_count > 0 THEN
    RAISE EXCEPTION 'migration blocked: % historical supplier failure(s) lack provable accepted-route resolution; reconcile before applying route-generation enforcement', unresolved_count;
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_reject_supplier_failure_resolution_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'supplier failure resolution history is append-only' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_reject_supplier_failure_resolution_mutation() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER supplier_fulfillment_outcome_resolution_append_only
  BEFORE UPDATE OR DELETE ON public.supplier_fulfillment_outcome_resolution
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_supplier_failure_resolution_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_snapshot_supplier_failure_route() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_supplier_id text; current_generation integer; failure_case_state text; failure_case_order_id text; item_order_id text;
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  -- Match offer writes' item → route → case order. Case closure holds only the
  -- case row and never waits on an item, so taking the case last remains safe.
  SELECT item.order_id INTO item_order_id FROM public.customer_order_item item WHERE item.id = NEW.order_item_id;
  PERFORM 1 FROM public.order_item_fulfillment fulfillment
   WHERE fulfillment.order_item_id = NEW.order_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier failure route is unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT route.supplier_id, route.route_generation
    INTO current_supplier_id, current_generation
    FROM public.order_item_fulfillment_supplier route
   WHERE route.order_item_id = NEW.order_item_id FOR UPDATE;
  SELECT case_row.state, case_row.order_id INTO failure_case_state, failure_case_order_id
    FROM public.support_case case_row WHERE case_row.id = NEW.support_case_id FOR SHARE;
  IF failure_case_state IS NULL OR failure_case_state IN ('RESOLVED','CLOSED')
     OR failure_case_order_id IS DISTINCT FROM item_order_id THEN
    RAISE EXCEPTION 'supplier failure requires an active Support case for the same order' USING ERRCODE = '42501';
  END IF;
  IF current_supplier_id IS NULL OR current_supplier_id IS DISTINCT FROM NEW.supplier_id THEN
    RAISE EXCEPTION 'supplier failure must match the current route' USING ERRCODE = '42501';
  END IF;
  NEW.route_generation := current_generation;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_snapshot_supplier_failure_route() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER supplier_fulfillment_outcome_route_snapshot
  BEFORE INSERT ON public.supplier_fulfillment_outcome
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_snapshot_supplier_failure_route();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_lock_active_supplier_failure_case_for_offer_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE case_ref text; case_state text;
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  SELECT offer.support_case_id INTO case_ref FROM public.order_item_equivalent_offer offer WHERE offer.id = NEW.offer_id;
  IF case_ref IS NULL THEN RAISE EXCEPTION 'equivalent offer case is unavailable' USING ERRCODE = '42501'; END IF;
  -- The item lock is taken by the existing append-only event guard. This
  -- shared case lock is compatible with other work and serializes this event
  -- with a case state update without reversing the close trigger lock order.
  SELECT case_row.state INTO case_state FROM public.support_case case_row
   WHERE case_row.id = case_ref FOR SHARE;
  IF case_state IS NULL OR case_state IN ('RESOLVED','CLOSED') THEN
    RAISE EXCEPTION 'equivalent offer requires an active Support case' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_lock_active_supplier_failure_case_for_offer_event() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER equivalent_offer_event_case_lock_guard
  BEFORE INSERT ON public.order_item_equivalent_offer_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_lock_active_supplier_failure_case_for_offer_event();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_require_current_supplier_failure_for_offer_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE item_ref text; case_ref text; offered_generation integer;
  current_supplier_id text; current_generation integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  SELECT offer.order_item_id, offer.support_case_id, route.route_generation
    INTO item_ref, case_ref, offered_generation
    FROM public.order_item_equivalent_offer offer
    JOIN public.order_item_equivalent_offer_route route ON route.offer_id = offer.id
   WHERE offer.id = NEW.offer_id;
  IF item_ref IS NULL THEN
    RAISE EXCEPTION 'equivalent offer route is unavailable' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.order_item_fulfillment fulfillment
   WHERE fulfillment.order_item_id = item_ref FOR UPDATE;
  SELECT route.supplier_id, route.route_generation
    INTO current_supplier_id, current_generation
    FROM public.order_item_fulfillment_supplier route
   WHERE route.order_item_id = item_ref FOR KEY SHARE;
  IF offered_generation <> current_generation + 1 OR NOT EXISTS (
    SELECT 1 FROM public.support_case case_row
    JOIN public.supplier_fulfillment_outcome outcome ON outcome.support_case_id = case_row.id
    WHERE case_row.id = case_ref AND case_row.state NOT IN ('RESOLVED','CLOSED')
      AND outcome.order_item_id = item_ref
      AND outcome.supplier_id = current_supplier_id
      AND outcome.route_generation = current_generation
  ) THEN
    RAISE EXCEPTION 'equivalent offer requires a current supplier failure on this route generation' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_require_current_supplier_failure_for_offer_event() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER equivalent_offer_event_current_failure_guard
  BEFORE INSERT ON public.order_item_equivalent_offer_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_require_current_supplier_failure_for_offer_event();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_resolve_supplier_failures_after_route_acceptance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE offer_case_id text; order_actor_id text;
BEGIN
  IF NEW.route_generation <= OLD.route_generation THEN RETURN NEW; END IF;
  IF NEW.supplier_id IS NOT DISTINCT FROM OLD.supplier_id OR NEW.last_equivalent_offer_id IS NULL THEN
    RAISE EXCEPTION 'supplier route generation requires a new accepted supplier route' USING ERRCODE = '42501';
  END IF;
  SELECT offer.support_case_id, ord.actor_user_id
    INTO offer_case_id, order_actor_id
    FROM public.order_item_equivalent_offer offer
    JOIN public.order_item_equivalent_offer_route offer_route ON offer_route.offer_id = offer.id
    JOIN public.customer_order_item item ON item.id = offer.order_item_id
    JOIN public.customer_order ord ON ord.id = item.order_id
    JOIN public.support_case case_row ON case_row.id = offer.support_case_id
   WHERE offer.id = NEW.last_equivalent_offer_id
     AND offer.order_item_id = NEW.order_item_id
     AND offer_route.supplier_id = NEW.supplier_id
     AND offer_route.route_generation = NEW.route_generation
     AND case_row.order_id = item.order_id
     AND case_row.state NOT IN ('RESOLVED','CLOSED')
     AND EXISTS (
       SELECT 1 FROM public.order_item_equivalent_offer_event event
        WHERE event.offer_id = offer.id AND event.event_type = 'ACCEPTED'
          AND event.actor_user_id = ord.actor_user_id
          AND event.id = (SELECT latest.id FROM public.order_item_equivalent_offer_event latest
            WHERE latest.offer_id = offer.id ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
     );
  IF offer_case_id IS NULL OR order_actor_id IS NULL THEN
    RAISE EXCEPTION 'supplier route change requires the ordering customer accepted offer' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.supplier_fulfillment_outcome_resolution (outcome_id, offer_id, resolved_at)
  SELECT outcome.id, NEW.last_equivalent_offer_id, clock_timestamp()
    FROM public.supplier_fulfillment_outcome outcome
   WHERE outcome.order_item_id = NEW.order_item_id
     AND outcome.support_case_id = offer_case_id
     AND outcome.supplier_id = OLD.supplier_id
     AND outcome.route_generation = OLD.route_generation
  ON CONFLICT (outcome_id) DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_resolve_supplier_failures_after_route_acceptance() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER fulfillment_supplier_resolve_failure_outcomes
  AFTER UPDATE OF supplier_id, route_generation, last_equivalent_offer_id ON public.order_item_fulfillment_supplier
  FOR EACH ROW WHEN (NEW.route_generation > OLD.route_generation)
  EXECUTE FUNCTION public.gphkm_resolve_supplier_failures_after_route_acceptance();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_supplier_failure_case_can_close(target_case_id text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT (public.gphkm_support_admin_access(target_case_id, nullif(current_setting('app.user_id', true), ''))
      OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN'))
    AND NOT EXISTS (
      SELECT 1 FROM public.supplier_fulfillment_outcome outcome
      JOIN public.order_item_fulfillment fulfillment ON fulfillment.order_item_id = outcome.order_item_id
      WHERE outcome.support_case_id = target_case_id
        AND fulfillment.state <> 'CANCELED_REFUNDED'
        AND NOT EXISTS (
          SELECT 1 FROM public.supplier_fulfillment_outcome_resolution resolution
           WHERE resolution.outcome_id = outcome.id
        )
    )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_supplier_failure_case_can_close(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_supplier_failure_case_can_close(text) TO gphkm_runtime;--> statement-breakpoint

-- The UPDATE already locks the case row. Outcome and offer-event inserts take
-- FOR SHARE on that row before committing; do not then lock item rows here,
-- which would reverse their item-to-case order and deadlock customer acceptance.
CREATE OR REPLACE FUNCTION public.gphkm_guard_supplier_failure_case_close() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state OR NEW.state NOT IN ('RESOLVED','CLOSED') THEN RETURN NEW; END IF;
  IF NOT public.gphkm_supplier_failure_case_can_close(OLD.id) THEN
    RAISE EXCEPTION 'supplier failure case must remain active until every failed item has an accepted current route or is canceled/refunded' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_guard_supplier_failure_case_close() FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_gate_unresolved_supplier_failure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.supplier_fulfillment_outcome outcome
    WHERE outcome.order_item_id = NEW.order_item_id
      AND NOT EXISTS (
        SELECT 1 FROM public.supplier_fulfillment_outcome_resolution resolution
         WHERE resolution.outcome_id = outcome.id
      )
  ) AND NEW.state NOT IN ('ON_HOLD','CANCELLATION_REQUESTED','CANCELED_REFUNDED') THEN
    RAISE EXCEPTION 'resolve supplier failure through customer-approved equivalent or item cancellation before handoff' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_gate_unresolved_supplier_failure() FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_packet_attempt_supplier_failure_resolution_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.type NOT IN ('SEND','EML_EXPORT','PDF_EXPORT','MANUAL_SENT','MANUAL_SEND') THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM public.supplier_packet_item packet_item
    JOIN public.supplier_fulfillment_outcome outcome ON outcome.order_item_id = packet_item.order_item_id
    WHERE packet_item.packet_id = NEW.packet_id
      AND NOT EXISTS (
        SELECT 1 FROM public.supplier_fulfillment_outcome_resolution resolution
         WHERE resolution.outcome_id = outcome.id
      )
  ) THEN
    RAISE EXCEPTION 'resolve the current supplier failure before sending or exporting a packet' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_packet_attempt_supplier_failure_resolution_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER supplier_packet_attempt_supplier_failure_resolution_guard
  BEFORE INSERT ON public.supplier_packet_attempt
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_packet_attempt_supplier_failure_resolution_guard();
