-- Stable ordering for the staff closure request list.
CREATE INDEX organization_closure_request_updated_page_idx
  ON public.organization_closure_request(updated_at, id);
