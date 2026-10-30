-- Finance gets a narrow, paginated gross-profit projection without access to
-- customer order content, contact data, wallet ledger rows, or the full export.
CREATE OR REPLACE FUNCTION public.gphkm_finance_gross_profit_report(requested_page integer)
RETURNS TABLE(
  order_item_id text,
  purchase_at timestamptz,
  retail_minor numeric,
  refunded_minor numeric,
  known_direct_cost_minor numeric,
  cost_status text,
  gross_profit_minor numeric,
  current_page integer,
  total_pages integer,
  total_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF actor_id IS NULL OR NOT (
    public.gphkm_is_active_staff(actor_id, 'FINANCE')
    OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')
  ) THEN
    RAISE EXCEPTION 'finance gross-profit report unavailable' USING ERRCODE = '42501';
  END IF;
  IF requested_page IS NULL OR requested_page < 1 OR requested_page > 100000 THEN
    RAISE EXCEPTION 'finance gross-profit page invalid' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH cohort AS MATERIALIZED (
    SELECT item.id AS item_id, customer_order.created_at,
           item.placement_price_minor + item.writing_price_minor AS retail_minor,
           item.writing_selected, financial.supplier_id AS original_supplier_id,
           coalesce(financial.supplier_id, financial.fulfillment_supplier_id) AS original_cost_supplier_id,
           financial.source_cost_minor, financial.writing_direct_cost_minor
      FROM public.customer_order customer_order
      JOIN public.customer_order_item item ON item.order_id = customer_order.id
      JOIN public.order_item_financial financial ON financial.order_item_id = item.id
     WHERE customer_order.checkout_state = 'PAID'
       AND customer_order.created_at >= now() - interval '90 days'
  ),
  totals AS (
    SELECT count(*)::bigint AS total_count FROM cohort
  ),
  page_bounds AS (
    SELECT totals.total_count,
           greatest(1, ceil(totals.total_count::numeric / 50)::integer) AS total_pages,
           least(requested_page, greatest(1, ceil(totals.total_count::numeric / 50)::integer)) AS selected_page
      FROM totals
  ),
  page_items AS MATERIALIZED (
    SELECT cohort.* FROM cohort
     ORDER BY cohort.created_at DESC, cohort.item_id DESC
     LIMIT 50 OFFSET ((SELECT page_bounds.selected_page FROM page_bounds) - 1) * 50
  ),
  routes AS MATERIALIZED (
    SELECT page_items.item_id, route.supplier_id
      FROM page_items
      CROSS JOIN LATERAL public.gphkm_finance_item_suppliers(page_items.item_id) route
  ),
  routed_placement_costs AS (
    SELECT page_items.item_id,
           coalesce(sum(coalesce(cost_event.new_cost_minor,
             CASE WHEN routes.supplier_id = page_items.original_cost_supplier_id THEN page_items.source_cost_minor END)), 0)::numeric AS known_minor,
           bool_and(cost_event.id IS NOT NULL) AS all_confirmed,
           bool_or(cost_event.id IS NOT NULL OR
             (routes.supplier_id = page_items.original_cost_supplier_id AND page_items.source_cost_minor IS NOT NULL)) AS any_known
      FROM page_items
      JOIN routes ON routes.item_id = page_items.item_id
      LEFT JOIN LATERAL (
        SELECT event.id, event.new_cost_minor
          FROM public.supplier_order_item_cost_event event
         WHERE event.order_item_id = page_items.item_id
           AND event.supplier_id = routes.supplier_id
           AND event.component = 'PLACEMENT'
         ORDER BY event.created_at DESC, event.id DESC
         LIMIT 1
      ) cost_event ON true
     GROUP BY page_items.item_id
  ),
  internal_placement_costs AS (
    SELECT page_items.item_id,
           coalesce(cost_event.new_cost_minor, page_items.source_cost_minor, 0)::numeric AS known_minor,
           cost_event.id IS NOT NULL AS all_confirmed,
           (cost_event.id IS NOT NULL OR page_items.source_cost_minor IS NOT NULL) AS any_known
      FROM page_items
      LEFT JOIN LATERAL (
        SELECT event.id, event.new_cost_minor
          FROM public.supplier_order_item_cost_event event
         WHERE event.order_item_id = page_items.item_id
           AND event.supplier_id IS NULL
           AND event.component = 'PLACEMENT'
         ORDER BY event.created_at DESC, event.id DESC
         LIMIT 1
      ) cost_event ON true
     WHERE NOT EXISTS (SELECT 1 FROM routes WHERE routes.item_id = page_items.item_id)
  ),
  placement_costs AS (
    SELECT * FROM routed_placement_costs
    UNION ALL
    SELECT * FROM internal_placement_costs
  ),
  writing_costs AS (
    SELECT page_items.item_id,
           CASE WHEN NOT page_items.writing_selected THEN 0::numeric
             ELSE coalesce(cost_event.new_cost_minor, page_items.writing_direct_cost_minor, 0)::numeric END AS known_minor,
           (NOT page_items.writing_selected OR cost_event.id IS NOT NULL) AS all_confirmed,
           (NOT page_items.writing_selected OR cost_event.id IS NOT NULL OR page_items.writing_direct_cost_minor IS NOT NULL) AS any_known
      FROM page_items
      LEFT JOIN LATERAL (
        SELECT event.id, event.new_cost_minor
          FROM public.supplier_order_item_cost_event event
         WHERE event.order_item_id = page_items.item_id
           AND event.supplier_id IS NULL
           AND event.component = 'WRITING'
         ORDER BY event.created_at DESC, event.id DESC
         LIMIT 1
      ) cost_event ON page_items.writing_selected
  ),
  refunds AS (
    SELECT ledger.related_id AS item_id, sum(ledger.delta_minor)::numeric AS refunded_minor
      FROM public.wallet_ledger_entry ledger
      JOIN page_items ON page_items.item_id = ledger.related_id
     WHERE ledger.kind = 'ITEM_REFUND'
       AND ledger.related_type = 'CUSTOMER_ORDER_ITEM'
     GROUP BY ledger.related_id
  ),
  costs_and_sales AS (
    SELECT page_items.*,
           coalesce(refunds.refunded_minor, 0)::numeric AS refunded_minor,
           coalesce(placement_costs.known_minor, 0) + coalesce(writing_costs.known_minor, 0) AS known_cost_minor,
           placement_costs.all_confirmed AND writing_costs.all_confirmed AS costs_confirmed,
           placement_costs.any_known OR writing_costs.any_known AS any_cost_known
      FROM page_items
      JOIN placement_costs ON placement_costs.item_id = page_items.item_id
      JOIN writing_costs ON writing_costs.item_id = page_items.item_id
      LEFT JOIN refunds ON refunds.item_id = page_items.item_id
  )
  SELECT costs_and_sales.item_id, costs_and_sales.created_at,
         costs_and_sales.retail_minor::numeric, costs_and_sales.refunded_minor,
         costs_and_sales.known_cost_minor,
         CASE WHEN costs_and_sales.costs_confirmed THEN 'CONFIRMED'
              WHEN costs_and_sales.any_cost_known THEN 'PROVISIONAL'
              ELSE 'UNKNOWN' END,
         CASE WHEN costs_and_sales.costs_confirmed
              THEN costs_and_sales.retail_minor - costs_and_sales.refunded_minor - costs_and_sales.known_cost_minor
              ELSE NULL END,
         page_bounds.selected_page, page_bounds.total_pages, page_bounds.total_count
    FROM costs_and_sales CROSS JOIN page_bounds
   ORDER BY costs_and_sales.created_at DESC, costs_and_sales.item_id DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_finance_gross_profit_report(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_finance_gross_profit_report(integer) TO gphkm_runtime;
