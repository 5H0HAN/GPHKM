-- Legacy nullable policy snapshots remain readable but cannot be finalized.
CREATE OR REPLACE FUNCTION public.gphkm_validate_checkout_disclosures() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.checkout_state = 'PENDING_POST' AND NEW.checkout_state = 'PAID' AND (
    NEW.content_policy_version IS DISTINCT FROM 'gphkm-content-policy-v1'
    OR NEW.content_policy_accepted_at IS NULL
    OR NEW.content_sharing_notice_version IS DISTINCT FROM 'gphkm-content-sharing-v1'
    OR EXISTS (
      SELECT 1 FROM public.customer_order_item item
      WHERE item.order_id = NEW.id AND (
        item.consent_notice_version IS DISTINCT FROM 'gphkm-content-sharing-v1'
        OR item.placement_disclosure_version IS DISTINCT FROM 'gphkm-placement-disclosure-v1'
        OR (item.writing_selected AND item.writing_refund_disclosure_version IS DISTINCT FROM 'gphkm-writing-stages-v1')
        OR (NOT item.writing_selected AND item.writing_refund_disclosure_version IS NOT NULL)
      )
    )
  ) THEN
    RAISE EXCEPTION 'current checkout disclosures are required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
