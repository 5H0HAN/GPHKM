CREATE TABLE "finance_reconciliation_action" (
	"id" text PRIMARY KEY NOT NULL,
	"finding_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"outcome" text NOT NULL,
	"evidence_reference" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_reconciliation_action_outcome_valid" CHECK ("finance_reconciliation_action"."outcome" in ('CONFIRMED_EXPECTED','FOLLOW_UP_REQUIRED')),
	CONSTRAINT "finance_reconciliation_action_evidence_valid" CHECK (length(btrim("finance_reconciliation_action"."evidence_reference")) between 3 and 200),
	CONSTRAINT "finance_reconciliation_action_reason_valid" CHECK (length(btrim("finance_reconciliation_action"."reason")) between 10 and 1000)
);
--> statement-breakpoint
ALTER TABLE "finance_reconciliation_action" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_reconciliation_finding" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"organization_id" text,
	"fingerprint" text NOT NULL,
	"category" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"expected_minor" numeric(20, 0),
	"observed_minor" numeric(20, 0),
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_reconciliation_finding_run_fingerprint_uq" UNIQUE("run_id","fingerprint")
);
--> statement-breakpoint
ALTER TABLE "finance_reconciliation_finding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_reconciliation_run" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_reconciliation_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finance_reconciliation_action" ADD CONSTRAINT "finance_reconciliation_action_finding_id_finance_reconciliation_finding_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."finance_reconciliation_finding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_reconciliation_action" ADD CONSTRAINT "finance_reconciliation_action_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_reconciliation_finding" ADD CONSTRAINT "finance_reconciliation_finding_run_id_finance_reconciliation_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."finance_reconciliation_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_reconciliation_finding" ADD CONSTRAINT "finance_reconciliation_finding_owner_user_id_auth_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_reconciliation_finding" ADD CONSTRAINT "finance_reconciliation_finding_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_reconciliation_run" ADD CONSTRAINT "finance_reconciliation_run_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_reconciliation_action_finding_idx" ON "finance_reconciliation_action" USING btree ("finding_id","created_at");--> statement-breakpoint
CREATE INDEX "finance_reconciliation_finding_run_idx" ON "finance_reconciliation_finding" USING btree ("run_id","created_at");
--> statement-breakpoint
ALTER TABLE finance_reconciliation_finding ADD CONSTRAINT finance_reconciliation_finding_category_valid CHECK (category IN (
  'WALLET_PROJECTION_MISMATCH','TOPUP_LEDGER_MISMATCH','ORPHAN_TOPUP_CREDIT',
  'ORDER_DEBIT_MISMATCH','ORPHAN_ORDER_DEBIT','ITEM_REFUND_OVER_LIMIT',
  'ORPHAN_ITEM_REFUND','ACTIVE_HOLD_EXCEEDS_BALANCE','QUALIFYING_GRANT_MISMATCH'
));
ALTER TABLE finance_reconciliation_finding ADD CONSTRAINT finance_reconciliation_finding_summary_valid CHECK (length(summary) BETWEEN 1 AND 240);
ALTER TABLE finance_reconciliation_action ADD CONSTRAINT finance_reconciliation_action_text_safe CHECK (
  evidence_reference !~ '[[:cntrl:]]' AND reason !~ '[[:cntrl:]]'
);
REVOKE ALL ON finance_reconciliation_run, finance_reconciliation_finding, finance_reconciliation_action FROM PUBLIC, gphkm_runtime;

CREATE FUNCTION public.gphkm_reject_finance_reconciliation_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'finance reconciliation history is append-only' USING ERRCODE = '42501'; END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_finance_reconciliation_mutation() FROM PUBLIC;
CREATE TRIGGER finance_reconciliation_run_immutable BEFORE UPDATE OR DELETE ON finance_reconciliation_run
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_finance_reconciliation_mutation();
CREATE TRIGGER finance_reconciliation_finding_immutable BEFORE UPDATE OR DELETE ON finance_reconciliation_finding
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_finance_reconciliation_mutation();
CREATE TRIGGER finance_reconciliation_action_immutable BEFORE UPDATE OR DELETE ON finance_reconciliation_action
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_finance_reconciliation_mutation();

CREATE FUNCTION public.gphkm_run_finance_reconciliation() RETURNS text
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
    CASE WHEN a.state = 'SETTLED' THEN a.amount_minor ELSE 0 END, c.credited_minor,
    'Top-up attempt state and its exact wallet credit do not agree.'
  FROM public.payment_attempt a
  CROSS JOIN LATERAL (
    SELECT count(*) AS entry_count, coalesce(sum(l.delta_minor), 0) AS credited_minor
    FROM public.wallet_ledger_entry l
    WHERE l.organization_id = a.organization_id AND l.kind = 'TOP_UP'
      AND l.operation = 'STRIPE_TOP_UP' AND l.idempotency_key = a.id
  ) c
  WHERE (a.state = 'SETTLED' AND (c.entry_count <> 1 OR c.credited_minor <> a.amount_minor))
     OR (a.state <> 'SETTLED' AND c.entry_count <> 0);

  INSERT INTO public.finance_reconciliation_finding(id, run_id, owner_user_id, organization_id,
    fingerprint, category, target_type, target_id, expected_minor, observed_minor, summary)
  SELECT gen_random_uuid()::text, target_run_id, actor_id, l.organization_id,
    'orphan-topup:' || l.id, 'ORPHAN_TOPUP_CREDIT', 'LEDGER_ENTRY', l.id,
    NULL, l.delta_minor, 'Stripe top-up ledger credit has no matching payment attempt.'
  FROM public.wallet_ledger_entry l
  WHERE l.kind = 'TOP_UP' AND l.operation = 'STRIPE_TOP_UP'
    AND NOT EXISTS (SELECT 1 FROM public.payment_attempt a WHERE a.id = l.idempotency_key
      AND a.organization_id = l.organization_id AND a.state = 'SETTLED' AND a.amount_minor = l.delta_minor);

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
  WHERE a.state = 'SETTLED' AND a.amount_minor >= p.minimum_minor AND l.id IS NOT NULL AND g.id IS NULL;

  INSERT INTO public.audit_event(id, actor_user_id, action, target_type, target_id, reason_code, metadata)
  SELECT gen_random_uuid()::text, actor_id, 'FINANCE_RECONCILIATION_RUN', 'FINANCE_RECONCILIATION_RUN', target_run_id,
    'READ_ONLY_CONSISTENCY_SCAN', jsonb_build_object('findingCount', count(*))
  FROM public.finance_reconciliation_finding f WHERE f.run_id = target_run_id;
  RETURN target_run_id;
END;
$$;

CREATE FUNCTION public.gphkm_get_latest_finance_reconciliation() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); result jsonb;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'FINANCE') THEN
    RAISE EXCEPTION 'finance reconciliation unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object('runId', r.id, 'createdAt', r.created_at, 'findingCount', count(f.id),
    'findings', coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'organizationId', f.organization_id, 'category', f.category,
      'targetType', f.target_type, 'targetId', f.target_id, 'expectedMinor', f.expected_minor::text,
      'observedMinor', f.observed_minor::text, 'summary', f.summary, 'ownerUserId', f.owner_user_id,
      'outcome', a.outcome, 'evidenceReference', a.evidence_reference, 'reason', a.reason,
      'reviewedAt', a.created_at
    ) ORDER BY f.created_at, f.id) FILTER (WHERE f.id IS NOT NULL), '[]'::jsonb))
  INTO result
  FROM (SELECT id, created_at FROM public.finance_reconciliation_run ORDER BY created_at DESC, id DESC LIMIT 1) r
  LEFT JOIN public.finance_reconciliation_finding f ON f.run_id = r.id
  LEFT JOIN LATERAL (SELECT x.outcome, x.evidence_reference, x.reason, x.created_at
    FROM public.finance_reconciliation_action x WHERE x.finding_id = f.id
    ORDER BY x.created_at DESC, x.id DESC LIMIT 1) a ON true
  GROUP BY r.id, r.created_at;
  RETURN result;
END;
$$;

CREATE FUNCTION public.gphkm_record_finance_reconciliation_action(
  target_finding_id text, target_outcome text, target_evidence_reference text, target_reason text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); org_id text;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'FINANCE')
    OR target_finding_id !~ '^[0-9a-f-]{36}$'
    OR target_outcome NOT IN ('CONFIRMED_EXPECTED','FOLLOW_UP_REQUIRED')
    OR target_evidence_reference IS NULL OR length(btrim(target_evidence_reference)) NOT BETWEEN 3 AND 200
    OR target_evidence_reference ~ '[[:cntrl:]]'
    OR target_reason IS NULL OR length(btrim(target_reason)) NOT BETWEEN 10 AND 1000
    OR target_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid finance reconciliation action' USING ERRCODE = '42501';
  END IF;
  SELECT organization_id INTO org_id FROM public.finance_reconciliation_finding WHERE id = target_finding_id;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.finance_reconciliation_action(id, finding_id, actor_user_id, outcome, evidence_reference, reason)
    VALUES (gen_random_uuid()::text, target_finding_id, actor_id, target_outcome,
      btrim(target_evidence_reference), btrim(target_reason));
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, org_id, actor_id, 'FINANCE_RECONCILIATION_ACTION',
      'FINANCE_RECONCILIATION_FINDING', target_finding_id, target_outcome,
      jsonb_build_object('evidenceReference', btrim(target_evidence_reference)));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.gphkm_run_finance_reconciliation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gphkm_get_latest_finance_reconciliation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gphkm_record_finance_reconciliation_action(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_run_finance_reconciliation() TO gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_get_latest_finance_reconciliation() TO gphkm_runtime;
GRANT EXECUTE ON FUNCTION public.gphkm_record_finance_reconciliation_action(text, text, text, text) TO gphkm_runtime;
