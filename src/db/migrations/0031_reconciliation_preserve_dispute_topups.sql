-- Reconciliation must preserve the original top-up credit during disputes and reversals.
CREATE OR REPLACE FUNCTION public.gphkm_run_finance_reconciliation() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  target_run_id text := gen_random_uuid()::text;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'FINANCE') THEN
    RAISE EXCEPTION 'finance reconciliation unavailable' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.finance_reconciliation_run(id, actor_user_id) VALUES (target_run_id, actor_id);

  INSERT INTO public.finance_reconciliation_finding(id, run_id, owner_user_id, organization_id,
    fingerprint, category, target_type, target_id, expected_minor, observed_minor, summary)
  SELECT gen_random_uuid()::text, target_run_id, actor_id, w.organization_id,
    'wallet:' || w.organization_id, 'WALLET_PROJECTION_MISMATCH', 'ORGANIZATION', w.organization_id,
    coalesce(sum(l.delta_minor), 0), w.balance_minor, 'Wallet projection differs from the immutable ledger total.'
  FROM public.wallet_account w LEFT JOIN public.wallet_ledger_entry l ON l.organization_id = w.organization_id
  GROUP BY w.organization_id, w.balance_minor
  HAVING coalesce(sum(l.delta_minor), 0) <> w.balance_minor;

  INSERT INTO public.finance_reconciliation_finding(id, run_id, owner_user_id, organization_id,
    fingerprint, category, target_type, target_id, expected_minor, observed_minor, summary)
  SELECT gen_random_uuid()::text, target_run_id, actor_id, a.organization_id,
    'topup:' || a.id, 'TOPUP_LEDGER_MISMATCH', 'PAYMENT_ATTEMPT', a.id,
    CASE WHEN a.state IN ('SETTLED','DISPUTED','REVERSED') THEN a.amount_minor ELSE 0 END, c.credited_minor,
    'Top-up attempt state and its exact wallet credit do not agree.'
  FROM public.payment_attempt a
  CROSS JOIN LATERAL (
    SELECT count(*) AS entry_count, coalesce(sum(l.delta_minor), 0) AS credited_minor
    FROM public.wallet_ledger_entry l
    WHERE l.organization_id = a.organization_id AND l.kind = 'TOP_UP'
      AND l.operation = 'STRIPE_TOP_UP' AND l.idempotency_key = a.id
  ) c
  WHERE (a.state IN ('SETTLED','DISPUTED','REVERSED') AND (c.entry_count <> 1 OR c.credited_minor <> a.amount_minor))
     OR (a.state NOT IN ('SETTLED','DISPUTED','REVERSED') AND c.entry_count <> 0);

  INSERT INTO public.finance_reconciliation_finding(id, run_id, owner_user_id, organization_id,
    fingerprint, category, target_type, target_id, expected_minor, observed_minor, summary)
  SELECT gen_random_uuid()::text, target_run_id, actor_id, l.organization_id,
    'orphan-topup:' || l.id, 'ORPHAN_TOPUP_CREDIT', 'LEDGER_ENTRY', l.id,
    NULL, l.delta_minor, 'Stripe top-up ledger credit has no matching payment attempt.'
  FROM public.wallet_ledger_entry l
  WHERE l.kind = 'TOP_UP' AND l.operation = 'STRIPE_TOP_UP'
    AND NOT EXISTS (SELECT 1 FROM public.payment_attempt a WHERE a.id = l.idempotency_key
      AND a.organization_id = l.organization_id AND a.state IN ('SETTLED','DISPUTED','REVERSED')
      AND a.amount_minor = l.delta_minor);

  INSERT INTO public.finance_reconciliation_finding(id, run_id, owner_user_id, organization_id,
    fingerprint, category, target_type, target_id, expected_minor, observed_minor, summary)
  SELECT gen_random_uuid()::text, target_run_id, actor_id, o.organization_id,
    'order:' || o.id, 'ORDER_DEBIT_MISMATCH', 'CUSTOMER_ORDER', o.id,
    CASE WHEN o.checkout_state = 'PAID' THEN -o.total_minor ELSE 0 END, d.debit_minor,
    'Order payment state, frozen total, and linked wallet debit do not agree.'
  FROM public.customer_order o
  CROSS JOIN LATERAL (
    SELECT count(*) AS entry_count, coalesce(sum(l.delta_minor), 0) AS debit_minor,
      count(*) FILTER (WHERE l.id = o.paid_ledger_entry_id AND l.organization_id = o.organization_id
        AND l.actor_user_id = o.actor_user_id AND l.delta_minor = -o.total_minor
        AND l.operation = 'ORDER_CHECKOUT:' || o.actor_user_id) AS exact_count
    FROM public.wallet_ledger_entry l
    WHERE l.kind = 'ORDER_DEBIT' AND l.related_type = 'CUSTOMER_ORDER' AND l.related_id = o.id
  ) d
  WHERE (o.checkout_state = 'PAID' AND (d.entry_count <> 1 OR d.exact_count <> 1 OR d.debit_minor <> -o.total_minor))
     OR (o.checkout_state <> 'PAID' AND d.entry_count <> 0);

  INSERT INTO public.finance_reconciliation_finding(id, run_id, owner_user_id, organization_id,
    fingerprint, category, target_type, target_id, expected_minor, observed_minor, summary)
  SELECT gen_random_uuid()::text, target_run_id, actor_id, l.organization_id,
    'orphan-order-debit:' || l.id, 'ORPHAN_ORDER_DEBIT', 'LEDGER_ENTRY', l.id,
    NULL, l.delta_minor, 'Order debit does not match a paid order reference.'
  FROM public.wallet_ledger_entry l
  WHERE l.kind = 'ORDER_DEBIT' AND NOT EXISTS (
    SELECT 1 FROM public.customer_order o WHERE o.id = l.related_id AND o.organization_id = l.organization_id
      AND o.checkout_state = 'PAID' AND o.paid_ledger_entry_id = l.id AND l.related_type = 'CUSTOMER_ORDER'
      AND l.delta_minor = -o.total_minor AND l.operation = 'ORDER_CHECKOUT:' || o.actor_user_id
  );

  INSERT INTO public.finance_reconciliation_finding(id, run_id, owner_user_id, organization_id,
    fingerprint, category, target_type, target_id, expected_minor, observed_minor, summary)
  SELECT gen_random_uuid()::text, target_run_id, actor_id, o.organization_id,
    'item-refund:' || i.id, 'ITEM_REFUND_OVER_LIMIT', 'CUSTOMER_ORDER_ITEM', i.id,
    i.placement_price_minor + i.writing_price_minor, r.refunded_minor,
    'Item wallet refunds exceed the amount originally charged for that item.'
  FROM public.customer_order_item i JOIN public.customer_order o ON o.id = i.order_id
  CROSS JOIN LATERAL (
    SELECT coalesce(sum(l.delta_minor), 0) AS refunded_minor FROM public.wallet_ledger_entry l
    WHERE l.organization_id = o.organization_id AND l.kind = 'ITEM_REFUND'
      AND l.related_type = 'CUSTOMER_ORDER_ITEM' AND l.related_id = i.id
  ) r
  WHERE r.refunded_minor > i.placement_price_minor + i.writing_price_minor;

  INSERT INTO public.finance_reconciliation_finding(id, run_id, owner_user_id, organization_id,
    fingerprint, category, target_type, target_id, expected_minor, observed_minor, summary)
  SELECT gen_random_uuid()::text, target_run_id, actor_id, l.organization_id,
    'orphan-refund:' || l.id, 'ORPHAN_ITEM_REFUND', 'LEDGER_ENTRY', l.id,
    NULL, l.delta_minor, 'Item refund does not reference a valid charged order item.'
  FROM public.wallet_ledger_entry l
  WHERE l.kind = 'ITEM_REFUND' AND l.related_type = 'CUSTOMER_ORDER_ITEM' AND NOT EXISTS (
    SELECT 1 FROM public.customer_order_item i JOIN public.customer_order o ON o.id = i.order_id
    WHERE i.id = l.related_id AND o.organization_id = l.organization_id AND o.checkout_state = 'PAID'
  );

  INSERT INTO public.finance_reconciliation_finding(id, run_id, owner_user_id, organization_id,
    fingerprint, category, target_type, target_id, expected_minor, observed_minor, summary)
  SELECT gen_random_uuid()::text, target_run_id, actor_id, w.organization_id,
    'holds:' || w.organization_id, 'ACTIVE_HOLD_EXCEEDS_BALANCE', 'ORGANIZATION', w.organization_id,
    w.balance_minor, h.held_minor, 'Active wallet holds exceed the current wallet balance projection.'
  FROM public.wallet_account w CROSS JOIN LATERAL (
    SELECT coalesce(sum(amount_minor), 0) AS held_minor FROM public.wallet_hold
    WHERE organization_id = w.organization_id AND state = 'ACTIVE'
  ) h WHERE h.held_minor > w.balance_minor;

  INSERT INTO public.finance_reconciliation_finding(id, run_id, owner_user_id, organization_id,
    fingerprint, category, target_type, target_id, expected_minor, observed_minor, summary)
  SELECT gen_random_uuid()::text, target_run_id, actor_id, a.organization_id,
    'grant:' || a.id, 'QUALIFYING_GRANT_MISMATCH', 'PAYMENT_ATTEMPT', a.id,
    a.amount_minor, 0, 'A settled qualifying top-up must have its linked access grant.'
  FROM public.payment_attempt a JOIN public.access_policy p ON p.id = 1
  LEFT JOIN public.wallet_ledger_entry l ON l.organization_id = a.organization_id
    AND l.operation = 'STRIPE_TOP_UP' AND l.idempotency_key = a.id AND l.kind = 'TOP_UP'
  LEFT JOIN public.access_grant g ON g.ledger_entry_id = l.id AND g.organization_id = a.organization_id
  WHERE a.state IN ('SETTLED','DISPUTED','REVERSED') AND a.amount_minor >= p.minimum_minor AND l.id IS NOT NULL AND g.id IS NULL;

  INSERT INTO public.audit_event(id, actor_user_id, action, target_type, target_id, reason_code, metadata)
  SELECT gen_random_uuid()::text, actor_id, 'FINANCE_RECONCILIATION_RUN', 'FINANCE_RECONCILIATION_RUN', target_run_id,
    'READ_ONLY_CONSISTENCY_SCAN', jsonb_build_object('findingCount', count(*))
  FROM public.finance_reconciliation_finding f WHERE f.run_id = target_run_id;
  RETURN target_run_id;
END;
$$;
