-- Keep supplier failure counts within the same paid-order cohort as the profile metrics.
CREATE OR REPLACE FUNCTION public.gphkm_supplier_operational_summary_unbounded(target_supplier_id text, since_at timestamptz)
RETURNS TABLE(
  paid_placements bigint,
  completed bigint,
  rejected bigint,
  canceled bigint,
  median_publication_hours double precision,
  on_time_count bigint,
  on_time_sample_size bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF actor_id IS NULL OR NOT (
    public.gphkm_is_active_staff(actor_id, 'ADMIN')
    OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')
  ) THEN
    RAISE EXCEPTION 'supplier operational summary unavailable' USING ERRCODE = '42501';
  END IF;
  IF target_supplier_id IS NULL OR length(target_supplier_id) > 80 OR since_at IS NULL THEN
    RAISE EXCEPTION 'supplier operational summary input invalid' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH paid_items AS (
    SELECT oi.id AS item_id, oi.customer_listing_snapshot, oi.writing_selected, f.state, o.created_at,
      (SELECT max(e.verified_at) FROM public.publication_evidence e WHERE e.order_item_id = oi.id) AS verified_at
    FROM public.order_item_fulfillment_supplier fs
    JOIN public.customer_order_item oi ON oi.id = fs.order_item_id
    JOIN public.customer_order o ON o.id = oi.order_id
    JOIN public.order_item_fulfillment f ON f.order_item_id = oi.id
    WHERE fs.supplier_id = target_supplier_id
      AND o.checkout_state = 'PAID'
      AND o.created_at >= since_at
  ),
  completed_items AS (
    SELECT p.*,
      extract(epoch FROM (p.verified_at - p.created_at)) / 3600.0 AS elapsed_hours,
      CASE
        WHEN p.customer_listing_snapshot->>'turnaroundDays' ~ '^[0-9]{1,3}$'
          AND (NOT p.writing_selected
            OR p.customer_listing_snapshot->>'writingTurnaroundDays' ~ '^[0-9]{1,3}$')
        THEN (p.customer_listing_snapshot->>'turnaroundDays')::integer * 24
          + CASE WHEN p.writing_selected
            THEN (p.customer_listing_snapshot->>'writingTurnaroundDays')::integer * 24 ELSE 0 END
        ELSE NULL
      END AS allowed_hours
    FROM paid_items p
    WHERE p.state = 'COMPLETED' AND p.verified_at >= p.created_at
  ),
  failures AS (
    SELECT count(DISTINCT outcome.order_item_id)::bigint AS total
    FROM public.supplier_fulfillment_outcome outcome
    JOIN paid_items p ON p.item_id = outcome.order_item_id
    WHERE outcome.supplier_id = target_supplier_id AND outcome.created_at >= since_at
  )
  SELECT
    (SELECT count(*)::bigint FROM paid_items),
    (SELECT count(*)::bigint FROM paid_items WHERE state = 'COMPLETED'),
    (SELECT failures.total FROM failures),
    (SELECT count(*)::bigint FROM paid_items WHERE state = 'CANCELED_REFUNDED'),
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY elapsed_hours::double precision) FROM completed_items),
    (SELECT count(*)::bigint FROM completed_items WHERE allowed_hours IS NOT NULL AND elapsed_hours <= allowed_hours),
    (SELECT count(*)::bigint FROM completed_items WHERE allowed_hours IS NOT NULL);
END;
$$;
