-- A publication may be verified only while its item is in the documented
-- verification states. A completed item must first enter a correction case.
DROP POLICY publication_evidence_assigned_insert ON public.publication_evidence;
CREATE POLICY publication_evidence_assigned_insert ON public.publication_evidence FOR INSERT TO gphkm_runtime WITH CHECK (
  verified_by_user_id = nullif(current_setting('app.user_id', true), '')
  AND EXISTS (SELECT 1 FROM public.order_item_fulfillment f WHERE f.order_item_id = publication_evidence.order_item_id
    AND f.state IN ('PUBLICATION_PENDING', 'EVIDENCE_REVIEW')
    AND (f.assigned_admin_id = nullif(current_setting('app.user_id', true), '')
      OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN'))
  )
);

-- Only one unresolved correction may exist for an item at a time.
DROP POLICY publication_correction_case_assigned_insert ON public.publication_correction_case;
CREATE POLICY publication_correction_case_assigned_insert ON public.publication_correction_case FOR INSERT TO gphkm_runtime
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
    AND NOT EXISTS (SELECT 1 FROM public.publication_correction_case prior
      WHERE prior.order_item_id = publication_correction_case.order_item_id
        AND NOT EXISTS (SELECT 1 FROM public.publication_correction_event resolved
          WHERE resolved.correction_case_id = prior.id AND resolved.event_type = 'REVERIFIED'))
  );

CREATE OR REPLACE FUNCTION public.gphkm_validate_publication_correction_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  case_id text;
  item_id text;
  item_state text;
  resolved_evidence_id text;
BEGIN
  IF TG_TABLE_NAME = 'publication_correction_case' THEN
    case_id := NEW.id;
  ELSE
    case_id := NEW.correction_case_id;
  END IF;

  SELECT c.order_item_id INTO item_id FROM public.publication_correction_case c WHERE c.id = case_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT f.state INTO item_state FROM public.order_item_fulfillment f WHERE f.order_item_id = item_id;
  IF NOT EXISTS (SELECT 1 FROM public.publication_correction_event e
    WHERE e.correction_case_id = case_id AND e.event_type = 'OPENED') THEN
    RAISE EXCEPTION 'publication correction requires an opened event' USING ERRCODE = '23514';
  END IF;

  SELECT e.publication_evidence_id INTO resolved_evidence_id FROM public.publication_correction_event e
   WHERE e.correction_case_id = case_id AND e.event_type = 'REVERIFIED';
  IF resolved_evidence_id IS NULL THEN
    IF item_state <> 'PUBLICATION_PENDING' THEN
      RAISE EXCEPTION 'open publication correction must resume link verification' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.publication_correction_case prior
      WHERE prior.order_item_id = item_id AND prior.id <> case_id
        AND NOT EXISTS (SELECT 1 FROM public.publication_correction_event resolved
          WHERE resolved.correction_case_id = prior.id AND resolved.event_type = 'REVERIFIED')) THEN
      RAISE EXCEPTION 'only one open publication correction is allowed per item' USING ERRCODE = '23514';
    END IF;
  ELSIF item_state <> 'COMPLETED'
     OR NOT EXISTS (
       SELECT 1 FROM public.publication_evidence evidence
        WHERE evidence.id = resolved_evidence_id AND evidence.order_item_id = item_id
          AND NOT EXISTS (SELECT 1 FROM public.publication_evidence newer
            WHERE newer.order_item_id = item_id
              AND (newer.verified_at, newer.id) > (evidence.verified_at, evidence.id))
     ) THEN
    RAISE EXCEPTION 'publication correction resolution requires the latest completed verification' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
