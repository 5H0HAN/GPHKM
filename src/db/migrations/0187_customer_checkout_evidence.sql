-- Preserve legacy orders without assuming which disclosure was shown.
ALTER TABLE public.customer_order_item
  ADD COLUMN placement_disclosure_version text,
  ADD COLUMN writing_refund_disclosure_version text;
--> statement-breakpoint
ALTER TABLE public.customer_order_item
  ADD CONSTRAINT customer_order_item_disclosure_versions_valid CHECK (
    placement_disclosure_version IS NOT NULL
    AND length(placement_disclosure_version) BETWEEN 1 AND 80
    AND CASE WHEN writing_selected THEN
      writing_refund_disclosure_version IS NOT NULL AND length(writing_refund_disclosure_version) BETWEEN 1 AND 80
    ELSE writing_refund_disclosure_version IS NULL END
  ) NOT VALID;
--> statement-breakpoint
-- Keep correction reasons and staff evidence private. Return only the valid
-- customer links, with the same tenant/order check as the customer order read.
CREATE FUNCTION public.gphkm_customer_live_publication_urls(target_items text[])
RETURNS TABLE(order_item_id text, live_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT evidence.order_item_id, evidence.live_url
  FROM public.publication_evidence evidence
  WHERE cardinality(target_items) <= 1250 AND evidence.order_item_id = ANY(target_items)
    AND public.gphkm_customer_can_read_order_item(
      evidence.order_item_id, nullif(current_setting('app.user_id', true), ''),
      nullif(current_setting('app.organization_id', true), ''))
    AND NOT EXISTS (
      SELECT 1 FROM public.publication_correction_case correction
      WHERE correction.order_item_id = evidence.order_item_id
        AND correction.original_evidence_id = evidence.id
    )
  ORDER BY evidence.verified_at DESC, evidence.id DESC
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_customer_live_publication_urls(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_customer_live_publication_urls(text[]) TO gphkm_runtime;
