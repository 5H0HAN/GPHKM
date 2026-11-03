DROP POLICY support_event_customer_insert ON support_case_event;--> statement-breakpoint
CREATE POLICY support_event_customer_insert ON support_case_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id',true),'') AND actor_kind = 'CUSTOMER'
  AND ((kind = 'REPLY' AND audience = 'CUSTOMER') OR (kind = 'OPENED' AND audience = 'INTERNAL'))
  AND public.gphkm_support_customer_access(case_id, actor_user_id, nullif(current_setting('app.organization_id',true),''))
);
