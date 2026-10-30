-- Support queues use stable updated-at/id pagination within RLS scopes.
DROP INDEX IF EXISTS public.support_case_org_updated_idx;
CREATE INDEX support_case_org_updated_idx
  ON public.support_case(organization_id, updated_at, id);
CREATE INDEX support_case_updated_cursor_idx
  ON public.support_case(updated_at, id);
