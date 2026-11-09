-- The purchased order snapshot is implicit content version 1. The first
-- persisted change or recipient re-consent therefore starts at version 2.
CREATE OR REPLACE FUNCTION public.gphkm_validate_recipient_reconsent_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE request_row public.order_item_content_change_request%ROWTYPE;
  current_supplier_id text; current_recipient text; orderer_id text;
BEGIN
  SELECT * INTO request_row FROM public.order_item_content_change_request request WHERE request.id = NEW.request_id;
  IF NOT FOUND OR request_row.purpose <> 'RECIPIENT_RECONSENT' THEN RETURN NEW; END IF;
  SELECT route.supplier_id, lower(btrim(contact.email)), order_row.actor_user_id
    INTO current_supplier_id, current_recipient, orderer_id
    FROM public.order_item_fulfillment_supplier route
    JOIN public.supplier_contact contact ON contact.supplier_id = route.supplier_id AND contact.is_primary
    JOIN public.customer_order_item item ON item.id = route.order_item_id
    JOIN public.customer_order order_row ON order_row.id = item.order_id
   WHERE route.order_item_id = request_row.order_item_id;
  IF nullif(current_setting('app.staff_role', true), '') <> 'SUPER_ADMIN'
     OR NEW.approved_by_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')
     OR request_row.requested_by_user_id IS DISTINCT FROM orderer_id
     OR request_row.target_supplier_id IS DISTINCT FROM current_supplier_id
     OR NEW.order_item_id IS DISTINCT FROM request_row.order_item_id
     OR NEW.target_url IS DISTINCT FROM request_row.target_url
     OR NEW.anchor_text IS DISTINCT FROM request_row.anchor_text
     OR NEW.article_text IS DISTINCT FROM request_row.article_text
     OR NEW.instructions IS DISTINCT FROM coalesce(request_row.instructions, '')
     OR NEW.supplier_id IS DISTINCT FROM current_supplier_id
     OR lower(btrim(NEW.recipient_email)) IS DISTINCT FROM current_recipient
     OR NEW.version <> coalesce((SELECT max(version.version) FROM public.order_item_content_version version
       WHERE version.order_item_id = NEW.order_item_id), 1) + 1
     OR NOT public.gphkm_supplier_packet_retry_eligible(NEW.order_item_id, NULL) THEN
    RAISE EXCEPTION 'recipient re-consent version must preserve the approved packet content and bind the current recipient' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_validate_recipient_reconsent_version() FROM PUBLIC;
