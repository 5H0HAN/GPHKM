-- Supports stable ordering through a customer's organization-scoped inbox.
DROP INDEX IF EXISTS public.customer_notification_inbox_idx;
CREATE INDEX customer_notification_inbox_idx
  ON public.customer_notification(organization_id, recipient_user_id, created_at, id);
