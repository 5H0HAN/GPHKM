-- Supports stable keyset pagination for the staff audit feed.
CREATE INDEX audit_event_created_cursor_idx
  ON public.audit_event(created_at, id);
