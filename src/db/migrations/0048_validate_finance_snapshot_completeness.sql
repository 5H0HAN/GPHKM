-- Completeness is enforced in PostgreSQL as well as by the provider adapter.
-- A lost dispute without a retrieved balance transaction is not enough
-- evidence to release the organization restriction.
CREATE FUNCTION public.gphkm_validate_stripe_finance_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.complete AND (
    NEW.facts->>'detailComplete' IS DISTINCT FROM 'true'
    OR NEW.facts->>'snapshotTruncated' IS DISTINCT FROM 'false'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.facts->'refunds') r
      WHERE r->>'status' = 'succeeded'
        AND (r->'balanceTransaction' IS NULL OR r->'balanceTransaction' = 'null'::jsonb))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.facts->'disputes') d
      WHERE d->>'status' = 'lost'
        AND jsonb_array_length(d->'balanceTransactions') = 0)
  ) THEN
    NEW.complete := false;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_validate_stripe_finance_snapshot() FROM PUBLIC;
CREATE TRIGGER stripe_finance_snapshot_validate_completeness
  BEFORE INSERT ON public.stripe_finance_snapshot
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_validate_stripe_finance_snapshot();
