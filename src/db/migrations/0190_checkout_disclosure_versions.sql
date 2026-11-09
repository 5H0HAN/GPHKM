ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_content_sharing_notice_current" CHECK ("customer_order"."content_sharing_notice_version" = 'gphkm-content-sharing-v1') NOT VALID;--> statement-breakpoint
ALTER TABLE "customer_order_item" ADD CONSTRAINT "customer_order_item_consent_notice_current" CHECK ("customer_order_item"."consent_notice_version" = 'gphkm-content-sharing-v1') NOT VALID;--> statement-breakpoint
ALTER TABLE "customer_order_item" ADD CONSTRAINT "customer_order_item_disclosure_versions_current" CHECK ("customer_order_item"."placement_disclosure_version" = 'gphkm-placement-disclosure-v1' and case when "customer_order_item"."writing_selected" then "customer_order_item"."writing_refund_disclosure_version" = 'gphkm-writing-stages-v1' else "customer_order_item"."writing_refund_disclosure_version" is null end) NOT VALID;--> statement-breakpoint
DROP POLICY customer_order_create ON customer_order;--> statement-breakpoint
CREATE POLICY customer_order_create ON customer_order FOR INSERT TO gphkm_runtime WITH CHECK (
  organization_id = nullif(current_setting('app.organization_id', true), '')
  AND actor_user_id = nullif(current_setting('app.user_id', true), '')
  AND checkout_state = 'PENDING_POST' AND paid_ledger_entry_id IS NULL AND customer_status = 'ORDER_RECEIVED'
  AND content_sharing_notice_version = 'gphkm-content-sharing-v1'
  AND content_policy_version = 'gphkm-content-policy-v1' AND content_policy_accepted_at IS NOT NULL
  AND public.gphkm_is_active_org_member(organization_id, actor_user_id)
);--> statement-breakpoint
DROP POLICY customer_order_item_create ON customer_order_item;--> statement-breakpoint
CREATE POLICY customer_order_item_create ON customer_order_item FOR INSERT TO gphkm_runtime WITH CHECK (
  customer_status = 'ORDER_RECEIVED' AND supplier_sharing_consented = true
  AND consent_notice_version = 'gphkm-content-sharing-v1'
  AND placement_disclosure_version = 'gphkm-placement-disclosure-v1'
  AND CASE WHEN writing_selected THEN writing_refund_disclosure_version = 'gphkm-writing-stages-v1'
    ELSE writing_refund_disclosure_version IS NULL END
  AND EXISTS (SELECT 1 FROM customer_order o WHERE o.id = customer_order_item.order_id
    AND o.checkout_state = 'PENDING_POST'
    AND o.customer_status = 'ORDER_RECEIVED'
    AND o.organization_id = nullif(current_setting('app.organization_id', true), '')
    AND o.actor_user_id = nullif(current_setting('app.user_id', true), ''))
);--> statement-breakpoint
-- CHECK constraints are NOT VALID so pre-existing immutable order snapshots remain readable.
-- This trigger also prevents a legacy pending order from being finalized without current consent.
CREATE FUNCTION public.gphkm_validate_checkout_disclosures() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.checkout_state = 'PENDING_POST' AND NEW.checkout_state = 'PAID' AND (
    NEW.content_sharing_notice_version IS DISTINCT FROM 'gphkm-content-sharing-v1'
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
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_validate_checkout_disclosures() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER customer_order_checkout_disclosures_current
  BEFORE UPDATE OF checkout_state ON public.customer_order
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_validate_checkout_disclosures();
