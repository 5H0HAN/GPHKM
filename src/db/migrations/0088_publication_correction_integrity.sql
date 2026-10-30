-- Require matching append-only audit facts before correction case/event rows
-- may be committed, even when called through the request database role.
CREATE FUNCTION public.gphkm_require_publication_correction_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE expected_action text; target_case_id text; actor_id text;
BEGIN
  IF TG_TABLE_NAME = 'publication_correction_case' THEN
    expected_action := 'PUBLICATION_CORRECTION_OPENED';
    target_case_id := NEW.id;
    actor_id := NEW.opened_by_user_id;
  ELSIF NEW.event_type = 'OPENED' THEN
    expected_action := 'PUBLICATION_CORRECTION_OPENED';
    target_case_id := NEW.correction_case_id;
    actor_id := NEW.actor_user_id;
  ELSE
    expected_action := 'PUBLICATION_CORRECTION_REVERIFIED';
    target_case_id := NEW.correction_case_id;
    actor_id := NEW.actor_user_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.audit_event audit
     WHERE audit.actor_user_id = actor_id
       AND audit.action = expected_action
       AND audit.target_type = 'PUBLICATION_CORRECTION_CASE'
       AND audit.target_id = target_case_id
  ) THEN
    RAISE EXCEPTION 'publication correction requires matching audit evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_require_publication_correction_audit() FROM PUBLIC;
CREATE TRIGGER publication_correction_case_requires_audit BEFORE INSERT ON public.publication_correction_case
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_require_publication_correction_audit();
CREATE TRIGGER publication_correction_event_requires_audit BEFORE INSERT ON public.publication_correction_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_require_publication_correction_audit();

CREATE FUNCTION public.gphkm_validate_publication_correction_lifecycle() RETURNS trigger
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
REVOKE ALL ON FUNCTION public.gphkm_validate_publication_correction_lifecycle() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER publication_correction_case_lifecycle
  AFTER INSERT ON public.publication_correction_case DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_validate_publication_correction_lifecycle();
CREATE CONSTRAINT TRIGGER publication_correction_event_lifecycle
  AFTER INSERT ON public.publication_correction_event DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_validate_publication_correction_lifecycle();
