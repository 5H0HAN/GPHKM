ALTER TABLE public.marketplace_listing_sourcing
  ADD CONSTRAINT marketplace_listing_supplier_identity_consistency
  CHECK (supplier_id IS NULL OR fulfillment_supplier_id IS NULL OR supplier_id = fulfillment_supplier_id);

ALTER TABLE public.order_item_financial
  ADD CONSTRAINT order_item_financial_supplier_identity_consistency
  CHECK (supplier_id IS NULL OR fulfillment_supplier_id IS NULL OR supplier_id = fulfillment_supplier_id);
