-- The signed Resend callback has its own restricted database login. A GUC is
-- useful as transaction context, but is not itself proof of the signature.
DROP POLICY supplier_packet_webhook_read ON public.supplier_packet;
CREATE POLICY supplier_packet_webhook_read ON public.supplier_packet FOR SELECT TO gphkm_resend_webhook USING (
  nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
  AND EXISTS (SELECT 1 FROM public.supplier_packet_attempt a WHERE a.packet_id = supplier_packet.id
    AND a.provider = 'RESEND' AND a.provider_reference = nullif(current_setting('app.resend_webhook_email_id', true), ''))
);

DROP POLICY supplier_packet_item_webhook_read ON public.supplier_packet_item;
CREATE POLICY supplier_packet_item_webhook_read ON public.supplier_packet_item FOR SELECT TO gphkm_resend_webhook USING (
  nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
  AND EXISTS (SELECT 1 FROM public.supplier_packet_attempt a WHERE a.packet_id = supplier_packet_item.packet_id
    AND a.provider = 'RESEND' AND a.provider_reference = nullif(current_setting('app.resend_webhook_email_id', true), ''))
);

DROP POLICY supplier_packet_attempt_webhook_read ON public.supplier_packet_attempt;
CREATE POLICY supplier_packet_attempt_webhook_read ON public.supplier_packet_attempt FOR SELECT TO gphkm_resend_webhook USING (
  nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
  AND provider = 'RESEND' AND type = 'SEND'
  AND (id = nullif(current_setting('app.resend_webhook_attempt_id', true), '')
    OR provider_reference = nullif(current_setting('app.resend_webhook_email_id', true), ''))
);

DROP POLICY supplier_packet_attempt_webhook_update ON public.supplier_packet_attempt;
CREATE POLICY supplier_packet_attempt_webhook_update ON public.supplier_packet_attempt FOR UPDATE TO gphkm_resend_webhook
  USING (nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
    AND provider = 'RESEND' AND type = 'SEND'
    AND (id = nullif(current_setting('app.resend_webhook_attempt_id', true), '')
      OR provider_reference = nullif(current_setting('app.resend_webhook_email_id', true), '')))
  WITH CHECK (nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
    AND provider = 'RESEND' AND type = 'SEND'
    AND (id = nullif(current_setting('app.resend_webhook_attempt_id', true), '')
      OR provider_reference = nullif(current_setting('app.resend_webhook_email_id', true), '')));

DROP POLICY supplier_packet_provider_event_webhook_read ON public.supplier_packet_provider_event;
CREATE POLICY supplier_packet_provider_event_webhook_read ON public.supplier_packet_provider_event FOR SELECT TO gphkm_resend_webhook
  USING (nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
    AND provider_event_id = nullif(current_setting('app.resend_webhook_event_id', true), ''));

DROP POLICY supplier_packet_provider_event_webhook_insert ON public.supplier_packet_provider_event;
CREATE POLICY supplier_packet_provider_event_webhook_insert ON public.supplier_packet_provider_event FOR INSERT TO gphkm_resend_webhook
  WITH CHECK (nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
    AND provider_event_id = nullif(current_setting('app.resend_webhook_event_id', true), '')
    AND provider_email_id = nullif(current_setting('app.resend_webhook_email_id', true), ''));

DROP POLICY supplier_packet_attempt_event_webhook_insert ON public.supplier_packet_attempt_event;
CREATE POLICY supplier_packet_attempt_event_webhook_insert ON public.supplier_packet_attempt_event FOR INSERT TO gphkm_resend_webhook
  WITH CHECK (actor_kind = 'PROVIDER' AND actor_user_id IS NULL
    AND nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
    AND EXISTS (SELECT 1 FROM public.supplier_packet_attempt a WHERE a.id = attempt_id
      AND a.provider = 'RESEND' AND a.type = 'SEND'
      AND (a.id = nullif(current_setting('app.resend_webhook_attempt_id', true), '')
        OR a.provider_reference = nullif(current_setting('app.resend_webhook_email_id', true), ''))));

DROP POLICY audit_event_resend_webhook_insert ON public.audit_event;
CREATE POLICY audit_event_resend_webhook_insert ON public.audit_event FOR INSERT TO gphkm_resend_webhook WITH CHECK (
  actor_user_id IS NULL
  AND nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
  AND action = 'FULFILLMENT_STATE_CHANGED'
  AND target_type = 'CUSTOMER_ORDER_ITEM'
  AND reason_code = 'PROVIDER_DELIVERED'
  AND EXISTS (SELECT 1 FROM public.supplier_packet_attempt a
    JOIN public.supplier_packet_item pi ON pi.packet_id = a.packet_id
    JOIN public.supplier_packet p ON p.id = a.packet_id
    WHERE pi.order_item_id = audit_event.target_id AND p.organization_id = audit_event.organization_id
      AND a.provider = 'RESEND' AND a.provider_reference = nullif(current_setting('app.resend_webhook_email_id', true), ''))
);

DROP POLICY audit_event_resend_webhook_cutoff_insert ON public.audit_event;
CREATE POLICY audit_event_resend_webhook_cutoff_insert ON public.audit_event FOR INSERT TO gphkm_resend_webhook WITH CHECK (
  actor_user_id IS NULL
  AND nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
  AND action = 'SUPPLIER_HANDOFF_CUTOFF_SET'
  AND target_type = 'CUSTOMER_ORDER_ITEM'
  AND reason_code = 'PROVIDER_ACCEPTED'
  AND EXISTS (SELECT 1 FROM public.supplier_packet_attempt a
    JOIN public.supplier_packet_item pi ON pi.packet_id = a.packet_id
    JOIN public.supplier_packet p ON p.id = a.packet_id
    WHERE pi.order_item_id = audit_event.target_id AND p.organization_id = audit_event.organization_id
      AND a.provider = 'RESEND' AND a.provider_reference = nullif(current_setting('app.resend_webhook_email_id', true), ''))
);

DROP POLICY order_item_fulfillment_resend_webhook_update ON public.order_item_fulfillment;
CREATE POLICY order_item_fulfillment_resend_webhook_update ON public.order_item_fulfillment FOR UPDATE TO gphkm_resend_webhook
  USING (nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
    AND public.gphkm_resend_webhook_can_update_item(order_item_id, nullif(current_setting('app.resend_webhook_email_id', true), '')))
  WITH CHECK (nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
    AND public.gphkm_resend_webhook_can_update_item(order_item_id, nullif(current_setting('app.resend_webhook_email_id', true), '')));

DROP POLICY order_item_fulfillment_resend_webhook_read ON public.order_item_fulfillment;
CREATE POLICY order_item_fulfillment_resend_webhook_read ON public.order_item_fulfillment FOR SELECT TO gphkm_resend_webhook
  USING (nullif(current_setting('app.resend_webhook_verified', true), '') = 'true'
    AND public.gphkm_resend_webhook_can_update_item(order_item_id, nullif(current_setting('app.resend_webhook_email_id', true), '')));

-- Remove the GUC-only webhook capability from the general request runtime.
REVOKE EXECUTE ON FUNCTION public.gphkm_resend_webhook_can_update_item(text, text) FROM gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_resend_webhook_can_update_item(text, text) TO gphkm_resend_webhook;

GRANT SELECT ON public.supplier_packet, public.supplier_packet_item, public.supplier_packet_attempt,
  public.supplier_packet_provider_event, public.order_item_fulfillment TO gphkm_resend_webhook;
GRANT INSERT ON public.supplier_packet_provider_event, public.supplier_packet_attempt_event, public.audit_event TO gphkm_resend_webhook;
GRANT UPDATE ON public.supplier_packet_attempt, public.order_item_fulfillment TO gphkm_resend_webhook;
REVOKE DELETE, TRUNCATE ON public.supplier_packet, public.supplier_packet_item, public.supplier_packet_attempt,
  public.supplier_packet_attempt_event, public.supplier_packet_provider_event, public.order_item_fulfillment, public.audit_event
  FROM gphkm_resend_webhook;

REVOKE ALL ON FUNCTION public.gphkm_process_stripe_event(text,text,text,text,text,text,text,numeric,text,text,timestamptz,text,text),
  public.gphkm_attach_stripe_event_facts(text,text,numeric,text,text) FROM gphkm_resend_webhook;

-- Notification delivery callbacks are processed by a fixed SECURITY DEFINER
-- command. Remove the old request-runtime grant and make Resend the sole app
-- role that can invoke it; the webhook role receives no notification-table
-- privileges.
REVOKE ALL ON FUNCTION public.gphkm_process_customer_notification_email_event(text,text,text,text,text,timestamptz)
  FROM gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_process_customer_notification_email_event(text,text,text,text,text,timestamptz)
  TO gphkm_resend_webhook;
