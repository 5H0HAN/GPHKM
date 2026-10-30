UPDATE public.marketplace_listing_sourcing
SET fulfillment_supplier_id = supplier_id, updated_at = now()
WHERE commercial_source = 'SUPPLIER_SOURCED' AND fulfillment_supplier_id IS NULL;--> statement-breakpoint
DROP TRIGGER order_item_financial_immutable ON public.order_item_financial;--> statement-breakpoint
UPDATE public.order_item_financial
SET fulfillment_supplier_id = supplier_id
WHERE supplier_id IS NOT NULL AND fulfillment_supplier_id IS NULL;--> statement-breakpoint
CREATE TRIGGER order_item_financial_immutable BEFORE UPDATE OR DELETE ON public.order_item_financial
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_order_mutation();--> statement-breakpoint
UPDATE public.order_item_fulfillment_supplier route
SET supplier_id = financial.fulfillment_supplier_id
FROM public.order_item_financial financial
WHERE route.order_item_id = financial.order_item_id
  AND route.supplier_id IS NULL AND financial.fulfillment_supplier_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE public.marketplace_listing_sourcing DROP CONSTRAINT marketplace_listing_supplier_identity_consistency;--> statement-breakpoint
ALTER TABLE public.order_item_financial DROP CONSTRAINT order_item_financial_supplier_identity_consistency;--> statement-breakpoint
ALTER TABLE public.marketplace_listing_sourcing ADD CONSTRAINT marketplace_listing_supplier_identity_consistency
  CHECK (supplier_id IS NULL OR (fulfillment_supplier_id IS NOT NULL AND supplier_id = fulfillment_supplier_id));--> statement-breakpoint
ALTER TABLE public.order_item_financial ADD CONSTRAINT order_item_financial_supplier_identity_consistency
  CHECK (supplier_id IS NULL OR (fulfillment_supplier_id IS NOT NULL AND supplier_id = fulfillment_supplier_id));
