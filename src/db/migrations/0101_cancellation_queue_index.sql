-- Supports stable paging for pending pre-handoff cancellation reviews.
CREATE INDEX order_item_cancellation_queue_idx
  ON public.order_item_cancellation_request(state, requested_at, id);
