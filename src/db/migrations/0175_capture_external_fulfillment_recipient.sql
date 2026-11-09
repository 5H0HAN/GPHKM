-- Every route that sends order content outside GPHKM needs a checkout-time
-- recipient snapshot, including platform-owned listings fulfilled by suppliers.
CREATE OR REPLACE FUNCTION public.gphkm_capture_supplier_recipient_consent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  item_row public.customer_order_item%ROWTYPE;
  source_supplier text;
  recipient text;
BEGIN
  IF NEW.supplier_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO item_row FROM public.customer_order_item WHERE id = NEW.order_item_id;
  SELECT fulfillment_supplier_id INTO source_supplier
    FROM public.order_item_financial WHERE order_item_id = NEW.order_item_id;
  IF item_row.id IS NULL OR NOT item_row.supplier_sharing_consented
    OR source_supplier IS DISTINCT FROM NEW.supplier_id THEN
    RAISE EXCEPTION 'supplier recipient consent source is unavailable' USING ERRCODE = '23514';
  END IF;

  SELECT contact.email INTO recipient
    FROM public.supplier supplier_row
    JOIN public.supplier_contact contact ON contact.supplier_id = supplier_row.id
   WHERE supplier_row.id = NEW.supplier_id AND supplier_row.status = 'ACTIVE' AND contact.is_primary
   FOR SHARE OF contact;
  IF recipient IS NULL THEN
    RAISE EXCEPTION 'active supplier primary contact is required at checkout' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.order_item_supplier_consent
    (order_item_id, supplier_id, recipient_email, notice_version, accepted_at, capture_source)
  VALUES (NEW.order_item_id, NEW.supplier_id, recipient, item_row.consent_notice_version,
    item_row.consented_at, 'CHECKOUT_ROUTE');
  RETURN NEW;
END;
$$;
