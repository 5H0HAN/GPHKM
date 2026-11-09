-- Keep approved content scoped to the authenticated transaction actor and tenant.
CREATE OR REPLACE FUNCTION public.gphkm_customer_approved_content(target_request_id text, target_user_id text, target_org_id text)
RETURNS TABLE(version_id text, version integer, content_hash text, target_url text, anchor_text text, article_text text, instructions text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT version_row.id, version_row.version, version_row.content_hash, version_row.target_url,
    version_row.anchor_text, version_row.article_text, version_row.instructions
  FROM public.order_item_content_version version_row
  JOIN public.order_item_content_change_request request ON request.id = version_row.request_id
  JOIN public.customer_order_item item ON item.id = request.order_item_id
  JOIN public.customer_order order_row ON order_row.id = item.order_id
  LEFT JOIN public.order_item_fulfillment_supplier route ON route.order_item_id = item.id
  LEFT JOIN public.supplier_contact contact ON contact.supplier_id = route.supplier_id AND contact.is_primary
  WHERE request.id = target_request_id AND request.requested_by_user_id = target_user_id
    AND target_user_id = nullif(current_setting('app.user_id', true), '')
    AND target_org_id = nullif(current_setting('app.organization_id', true), '')
    AND order_row.actor_user_id = target_user_id AND order_row.organization_id = target_org_id
    AND public.gphkm_is_active_org_member(order_row.organization_id, target_user_id)
    AND EXISTS (SELECT 1 FROM public.order_item_content_change_event event
      WHERE event.request_id = request.id AND event.event_type = 'APPROVED'
        AND event.version_id = version_row.id AND event.content_hash = version_row.content_hash)
    AND version_row.order_item_id = item.id
    AND ((request.purpose = 'CONTENT_CHANGE' AND public.gphkm_change_request_before_handoff(item.id))
      OR (request.purpose = 'RECIPIENT_RECONSENT'
        AND version_row.supplier_id = route.supplier_id
        AND lower(btrim(version_row.recipient_email)) = lower(btrim(contact.email))
        AND (
          public.gphkm_supplier_packet_retry_eligible(item.id, NULL)
          OR EXISTS (SELECT 1 FROM public.order_item_content_change_event consent_event
            WHERE consent_event.request_id = request.id AND consent_event.event_type = 'CONSENTED'
              AND consent_event.actor_user_id = target_user_id
              AND consent_event.version_id = version_row.id
              AND consent_event.content_hash = version_row.content_hash)
        )))
$$;
