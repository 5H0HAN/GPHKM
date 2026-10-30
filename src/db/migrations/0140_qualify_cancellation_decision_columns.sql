-- The decision function's OUT parameter `order_item_id` conflicts with
-- unqualified table columns under PL/pgSQL. Qualify every affected query while
-- preserving the already-applied function definition and ACLs.
DO $migration$
DECLARE
  definition text;
  fulfillment_update text := 'UPDATE public.order_item_fulfillment SET';
  fulfillment_predicate text := 'WHERE order_item_id = request_row.order_item_id';
BEGIN
  SELECT pg_get_functiondef(
    'public.gphkm_decide_order_item_cancellation(text,text,text)'::regprocedure
  ) INTO definition;

  IF position('FROM public.order_item_fulfillment WHERE order_item_id = request_row.order_item_id FOR UPDATE' IN definition) = 0
    OR position('FROM public.order_item_writing WHERE order_item_id = item_row.id FOR UPDATE' IN definition) = 0
    OR (length(definition) - length(replace(definition, fulfillment_update, ''))) / length(fulfillment_update) <> 2
    OR (length(definition) - length(replace(definition, fulfillment_predicate, ''))) / length(fulfillment_predicate) <> 3 THEN
    RAISE EXCEPTION 'Cancellation decision function changed; review all order_item_id references before qualifying columns';
  END IF;

  definition := replace(
    definition,
    'FROM public.order_item_fulfillment WHERE order_item_id = request_row.order_item_id FOR UPDATE',
    'FROM public.order_item_fulfillment AS fulfillment_target WHERE fulfillment_target.order_item_id = request_row.order_item_id FOR UPDATE'
  );
  definition := replace(
    definition,
    'FROM public.order_item_writing WHERE order_item_id = item_row.id FOR UPDATE',
    'FROM public.order_item_writing AS writing_target WHERE writing_target.order_item_id = item_row.id FOR UPDATE'
  );
  definition := replace(definition, fulfillment_update, 'UPDATE public.order_item_fulfillment AS fulfillment_target SET');
  definition := replace(definition, fulfillment_predicate, 'WHERE fulfillment_target.order_item_id = request_row.order_item_id');
  EXECUTE definition;
END;
$migration$;
