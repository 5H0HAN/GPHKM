-- Avoid evaluating the evidence lookup for ordinary fulfillment transitions.
-- The webhook identity may update handoff milestones but must not read customer
-- publication evidence; completion still requires the existing evidence check.
CREATE OR REPLACE FUNCTION public.gphkm_require_publication_evidence_for_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.state = 'COMPLETED' AND OLD.state IS DISTINCT FROM NEW.state THEN
    IF NOT EXISTS (SELECT 1 FROM public.publication_evidence e WHERE e.order_item_id = NEW.order_item_id) THEN
      RAISE EXCEPTION 'publication evidence is required before completion' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_require_publication_evidence_for_completion() FROM PUBLIC;
