-- Provider bounce/failure confirms that the send request was accepted. Record
-- its cancellation cutoff using only the verified Resend message binding.
CREATE POLICY audit_event_resend_webhook_cutoff_insert ON audit_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id IS NULL
  AND nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
  AND action = 'SUPPLIER_HANDOFF_CUTOFF_SET'
  AND target_type = 'CUSTOMER_ORDER_ITEM'
  AND reason_code = 'PROVIDER_ACCEPTED'
  AND EXISTS (
    SELECT 1 FROM public.supplier_packet_attempt a
    JOIN public.supplier_packet_item pi ON pi.packet_id = a.packet_id
    JOIN public.supplier_packet p ON p.id = a.packet_id
    WHERE pi.order_item_id = audit_event.target_id
      AND p.organization_id = audit_event.organization_id
      AND a.provider = 'RESEND'
      AND a.provider_reference = nullif(current_setting('app.resend_webhook_email_id', true), '')
  )
);
