-- Custom SQL migration file, put your code below! --
-- Keep application writes to fulfillment limited to lifecycle fields. Identity,
-- ownership, assignment, and creation metadata are changed only by reviewed DB
-- commands (assignment uses gphkm_assign_fulfillment_item).
REVOKE UPDATE ON public.order_item_fulfillment FROM gphkm_runtime;
GRANT UPDATE (
  state,
  state_before_hold,
  state_before_cancellation,
  customer_status,
  next_update_at,
  work_started_at,
  handed_off_at,
  updated_at
) ON public.order_item_fulfillment TO gphkm_runtime;
