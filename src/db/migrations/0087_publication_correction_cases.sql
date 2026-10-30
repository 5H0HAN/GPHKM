CREATE TABLE publication_correction_case (
  id text PRIMARY KEY,
  order_item_id text NOT NULL REFERENCES order_item_fulfillment(order_item_id),
  original_evidence_id text NOT NULL UNIQUE REFERENCES publication_evidence(id),
  opened_by_user_id text NOT NULL REFERENCES auth_user(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 2000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_item_id, opened_by_user_id, idempotency_key)
);
CREATE INDEX publication_correction_item_created_idx ON publication_correction_case(order_item_id, created_at);
ALTER TABLE publication_correction_case ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON publication_correction_case TO gphkm_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON publication_correction_case FROM gphkm_runtime;

CREATE TABLE publication_correction_event (
  id text PRIMARY KEY,
  correction_case_id text NOT NULL REFERENCES publication_correction_case(id),
  actor_user_id text NOT NULL REFERENCES auth_user(id),
  event_type text NOT NULL CHECK (event_type IN ('OPENED', 'REVERIFIED')),
  publication_evidence_id text REFERENCES publication_evidence(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (correction_case_id, event_type),
  CHECK ((event_type = 'OPENED' AND publication_evidence_id IS NULL)
      OR (event_type = 'REVERIFIED' AND publication_evidence_id IS NOT NULL))
);
CREATE INDEX publication_correction_event_case_created_idx ON publication_correction_event(correction_case_id, created_at);
ALTER TABLE publication_correction_event ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON publication_correction_event TO gphkm_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON publication_correction_event FROM gphkm_runtime;

CREATE POLICY publication_correction_case_assigned_read ON publication_correction_case FOR SELECT TO gphkm_runtime
  USING (public.gphkm_staff_can_read_order_item(order_item_id, nullif(current_setting('app.user_id', true), '')));
CREATE POLICY publication_correction_case_assigned_insert ON publication_correction_case FOR INSERT TO gphkm_runtime
  WITH CHECK (
    opened_by_user_id = nullif(current_setting('app.user_id', true), '')
    AND (public.gphkm_is_active_staff(opened_by_user_id, 'ADMIN') OR public.gphkm_is_active_staff(opened_by_user_id, 'SUPER_ADMIN'))
    AND public.gphkm_staff_can_read_order_item(order_item_id, opened_by_user_id)
    AND EXISTS (SELECT 1 FROM public.order_item_fulfillment f
      WHERE f.order_item_id = publication_correction_case.order_item_id AND f.state = 'COMPLETED')
    AND EXISTS (SELECT 1 FROM public.publication_evidence e
      WHERE e.id = publication_correction_case.original_evidence_id AND e.order_item_id = publication_correction_case.order_item_id
        AND NOT EXISTS (SELECT 1 FROM public.publication_evidence newer
          WHERE newer.order_item_id = e.order_item_id
            AND (newer.verified_at, newer.id) > (e.verified_at, e.id)))
  );
CREATE POLICY publication_correction_event_assigned_read ON publication_correction_event FOR SELECT TO gphkm_runtime
  USING (EXISTS (SELECT 1 FROM public.publication_correction_case c
    WHERE c.id = publication_correction_event.correction_case_id));
CREATE POLICY publication_correction_event_assigned_insert ON publication_correction_event FOR INSERT TO gphkm_runtime
  WITH CHECK (
    actor_user_id = nullif(current_setting('app.user_id', true), '')
    AND EXISTS (SELECT 1 FROM public.publication_correction_case c
      WHERE c.id = publication_correction_event.correction_case_id
        AND public.gphkm_staff_can_read_order_item(c.order_item_id, actor_user_id)
        AND ((publication_correction_event.event_type = 'OPENED'
              AND c.opened_by_user_id = actor_user_id
              AND publication_correction_event.publication_evidence_id IS NULL)
          OR (publication_correction_event.event_type = 'REVERIFIED'
              AND EXISTS (SELECT 1 FROM public.publication_evidence e
                WHERE e.id = publication_correction_event.publication_evidence_id
                  AND e.order_item_id = c.order_item_id AND e.verified_by_user_id = actor_user_id)
              AND NOT EXISTS (SELECT 1 FROM public.publication_correction_event resolved
                WHERE resolved.correction_case_id = c.id AND resolved.event_type = 'REVERIFIED'))))
  );

CREATE TRIGGER publication_correction_case_immutable BEFORE UPDATE OR DELETE ON publication_correction_case
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_immutable_mutation();
CREATE TRIGGER publication_correction_event_immutable BEFORE UPDATE OR DELETE ON publication_correction_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_immutable_mutation();
