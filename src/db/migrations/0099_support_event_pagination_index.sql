-- Supports stable chronological paging for long customer and staff case histories.
DROP INDEX IF EXISTS public.support_case_event_history_idx;
CREATE INDEX support_case_event_history_idx
  ON public.support_case_event(case_id, created_at, id);
