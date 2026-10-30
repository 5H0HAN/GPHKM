-- Customer orders, frozen checkout terms, isolated financial snapshots, and constrained wallet posting.
DO $$
DECLARE ledger_owner name;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO ledger_owner FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'wallet_ledger_entry';
  IF current_user = 'gphkm_runtime' OR ledger_owner IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'order migration must run as the wallet table owner, never the runtime role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gphkm_runtime' AND rolbypassrls) THEN
    RAISE EXCEPTION 'gphkm_runtime must not bypass row-level security';
  END IF;
END
$$;
CREATE TABLE customer_order (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id),
  actor_user_id text NOT NULL REFERENCES auth_user(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  placement_total_minor numeric(20,0) NOT NULL CHECK (placement_total_minor >= 0),
  writing_total_minor numeric(20,0) NOT NULL CHECK (writing_total_minor >= 0),
  total_minor numeric(20,0) NOT NULL CHECK (total_minor > 0 AND total_minor = placement_total_minor + writing_total_minor),
  customer_status text NOT NULL DEFAULT 'ORDER_RECEIVED' CHECK (customer_status IN ('ORDER_RECEIVED','CONTENT_REVIEW','PREPARING','IN_PROGRESS','LINK_VERIFICATION','COMPLETE','RESOLVED')),
  checkout_state text NOT NULL DEFAULT 'PENDING_POST',
  content_sharing_notice_version text NOT NULL CHECK (length(content_sharing_notice_version) BETWEEN 1 AND 80),
  paid_ledger_entry_id text REFERENCES wallet_ledger_entry(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_order_org_actor_idem_uq UNIQUE (organization_id, actor_user_id, idempotency_key),
  CONSTRAINT customer_order_idempotency_valid CHECK (length(idempotency_key) BETWEEN 16 AND 128 AND request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_order_checkout_state_valid CHECK ((checkout_state = 'PENDING_POST' AND paid_ledger_entry_id IS NULL) OR (checkout_state = 'PAID' AND paid_ledger_entry_id IS NOT NULL))
);
CREATE INDEX customer_order_org_created_idx ON customer_order(organization_id, created_at);

CREATE TABLE customer_order_item (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES customer_order(id),
  listing_id text NOT NULL REFERENCES marketplace_listing(id),
  listing_revision integer NOT NULL CHECK (listing_revision > 0),
  customer_listing_snapshot jsonb NOT NULL CHECK (jsonb_typeof(customer_listing_snapshot) = 'object'),
  placement_price_minor numeric(20,0) NOT NULL CHECK (placement_price_minor > 0),
  writing_selected boolean NOT NULL,
  writing_price_minor numeric(20,0) NOT NULL DEFAULT 0 CHECK (writing_price_minor >= 0),
  writing_first_stage_minor numeric(20,0) NOT NULL DEFAULT 0 CHECK (writing_first_stage_minor >= 0),
  writing_final_stage_minor numeric(20,0) NOT NULL DEFAULT 0 CHECK (writing_final_stage_minor >= 0),
  target_url text NOT NULL CHECK (length(target_url) BETWEEN 1 AND 2048),
  anchor_text text NOT NULL CHECK (length(anchor_text) BETWEEN 1 AND 200),
  article_text text,
  writing_brief text,
  supplier_sharing_consented boolean NOT NULL CHECK (supplier_sharing_consented),
  consented_at timestamptz NOT NULL DEFAULT now(),
  consent_notice_version text NOT NULL CHECK (length(consent_notice_version) BETWEEN 1 AND 80),
  customer_status text NOT NULL DEFAULT 'ORDER_RECEIVED' CHECK (customer_status IN ('ORDER_RECEIVED','CONTENT_REVIEW','PREPARING','IN_PROGRESS','LINK_VERIFICATION','COMPLETE','RESOLVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_order_item_order_listing_uq UNIQUE (order_id, listing_id),
  CONSTRAINT customer_order_item_writing_price CHECK (writing_price_minor = writing_first_stage_minor + writing_final_stage_minor),
  CONSTRAINT customer_order_item_writing_valid CHECK (
    (NOT writing_selected AND writing_price_minor = 0 AND writing_first_stage_minor = 0 AND writing_final_stage_minor = 0 AND article_text IS NOT NULL AND writing_brief IS NULL)
    OR (writing_selected AND writing_brief IS NOT NULL AND article_text IS NULL)
  ),
  CONSTRAINT customer_order_item_text_bounds CHECK (
    (article_text IS NULL OR length(article_text) BETWEEN 1 AND 20000)
    AND (writing_brief IS NULL OR length(writing_brief) BETWEEN 1 AND 4000)
    AND (writing_selected OR length(article_text) <= 20000)
  )
);
CREATE INDEX customer_order_item_listing_idx ON customer_order_item(listing_id, created_at);

-- Cost/supplier snapshots are not queryable under customer tenant policies.
CREATE TABLE order_item_financial (
  order_item_id text PRIMARY KEY REFERENCES customer_order_item(id),
  commercial_source catalog_source NOT NULL,
  supplier_id text REFERENCES supplier(id),
  fulfillment_supplier_id text REFERENCES supplier(id),
  source_cost_minor numeric(20,0),
  writing_direct_cost_minor numeric(20,0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_item_financial_source_valid CHECK (
    (commercial_source = 'PLATFORM_OWNED' AND supplier_id IS NULL)
    OR (commercial_source = 'SUPPLIER_SOURCED' AND supplier_id IS NOT NULL)
  ),
  CONSTRAINT order_item_financial_cost_valid CHECK ((source_cost_minor IS NULL OR source_cost_minor >= 0) AND (writing_direct_cost_minor IS NULL OR writing_direct_cost_minor >= 0))
);

ALTER TABLE customer_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_order_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_financial ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON customer_order, customer_order_item TO gphkm_runtime;
GRANT SELECT ON order_item_financial TO gphkm_runtime;
REVOKE UPDATE, DELETE ON customer_order, customer_order_item, order_item_financial FROM gphkm_runtime;

CREATE POLICY customer_order_read ON customer_order FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_org_member(organization_id, nullif(current_setting('app.user_id', true), ''))
  AND organization_id = nullif(current_setting('app.organization_id', true), '')
  AND (actor_user_id = nullif(current_setting('app.user_id', true), '')
       OR public.gphkm_is_active_org_owner(organization_id, nullif(current_setting('app.user_id', true), '')))
);
CREATE POLICY customer_order_create ON customer_order FOR INSERT TO gphkm_runtime WITH CHECK (
  organization_id = nullif(current_setting('app.organization_id', true), '')
  AND actor_user_id = nullif(current_setting('app.user_id', true), '')
  AND checkout_state = 'PENDING_POST' AND paid_ledger_entry_id IS NULL AND customer_status = 'ORDER_RECEIVED'
  AND public.gphkm_is_active_org_member(organization_id, actor_user_id)
);
CREATE POLICY customer_order_item_read ON customer_order_item FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM customer_order o WHERE o.id = customer_order_item.order_id)
);
CREATE POLICY customer_order_item_create ON customer_order_item FOR INSERT TO gphkm_runtime WITH CHECK (
  customer_status = 'ORDER_RECEIVED' AND supplier_sharing_consented = true
  AND EXISTS (SELECT 1 FROM customer_order o WHERE o.id = customer_order_item.order_id
    AND o.checkout_state = 'PENDING_POST'
    AND o.customer_status = 'ORDER_RECEIVED'
    AND o.organization_id = nullif(current_setting('app.organization_id', true), '')
    AND o.actor_user_id = nullif(current_setting('app.user_id', true), ''))
);
CREATE POLICY order_item_financial_finance_read ON order_item_financial FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('FINANCE','SUPER_ADMIN'))
);

-- Frozen order facts cannot be rewritten by ordinary runtime SQL. Checkout status is changed only by the definer function.
CREATE FUNCTION public.gphkm_reject_order_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'order snapshots are immutable' USING ERRCODE = '42501'; END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_order_mutation() FROM PUBLIC;
CREATE TRIGGER customer_order_item_immutable BEFORE UPDATE OR DELETE ON customer_order_item
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_order_mutation();
CREATE TRIGGER order_item_financial_immutable BEFORE UPDATE OR DELETE ON order_item_financial
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_order_mutation();
CREATE FUNCTION public.gphkm_protect_order_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.actor_user_id <> OLD.actor_user_id
    OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.request_hash <> OLD.request_hash OR NEW.currency <> OLD.currency
    OR NEW.placement_total_minor <> OLD.placement_total_minor OR NEW.writing_total_minor <> OLD.writing_total_minor
    OR NEW.total_minor <> OLD.total_minor OR NEW.content_sharing_notice_version <> OLD.content_sharing_notice_version
    OR NEW.created_at <> OLD.created_at OR OLD.checkout_state <> 'PENDING_POST'
    OR NEW.checkout_state <> 'PAID' OR NEW.paid_ledger_entry_id IS NULL THEN
    RAISE EXCEPTION 'order snapshot mutation rejected' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_protect_order_snapshot() FROM PUBLIC;
CREATE TRIGGER customer_order_snapshot_protect BEFORE UPDATE ON customer_order
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_protect_order_snapshot();

CREATE FUNCTION public.gphkm_require_paid_order_at_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_order public.customer_order%ROWTYPE;
BEGIN
  SELECT * INTO current_order FROM public.customer_order WHERE id = NEW.id;
  IF NOT FOUND OR current_order.checkout_state <> 'PAID' OR current_order.paid_ledger_entry_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.wallet_ledger_entry w
      WHERE w.id = current_order.paid_ledger_entry_id AND w.organization_id = current_order.organization_id
        AND w.actor_user_id = current_order.actor_user_id AND w.kind = 'ORDER_DEBIT'
        AND w.delta_minor = -current_order.total_minor AND w.related_type = 'CUSTOMER_ORDER'
        AND w.related_id = current_order.id) THEN
    RAISE EXCEPTION 'order must commit with its exact wallet debit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_require_paid_order_at_commit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER customer_order_requires_debit
  AFTER INSERT ON customer_order DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_require_paid_order_at_commit();

CREATE FUNCTION public.gphkm_lock_pending_order_item() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE checkout_state text; customer_status text;
BEGIN
  SELECT o.checkout_state, o.customer_status INTO checkout_state, customer_status
    FROM public.customer_order o WHERE o.id = NEW.order_id FOR UPDATE;
  IF NOT FOUND OR checkout_state <> 'PENDING_POST' OR customer_status <> 'ORDER_RECEIVED' THEN
    RAISE EXCEPTION 'order no longer accepts items' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_lock_pending_order_item() FROM PUBLIC;
CREATE TRIGGER customer_order_item_pending_only BEFORE INSERT ON customer_order_item
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_lock_pending_order_item();

-- Revoke direct ledger writes. A narrowly scoped definer function below is the only ORDER_DEBIT path.
DROP POLICY wallet_ledger_tenant_insert ON wallet_ledger_entry;
REVOKE INSERT ON wallet_ledger_entry FROM gphkm_runtime;
-- Wallet creation remains supported, but only as an empty USD account.
DROP POLICY wallet_account_tenant_create ON wallet_account;
CREATE POLICY wallet_account_tenant_create ON wallet_account FOR INSERT TO gphkm_runtime WITH CHECK (
  organization_id = nullif(current_setting('app.organization_id', true), '')
  AND currency = 'USD' AND balance_minor = 0
);

CREATE FUNCTION public.gphkm_finalize_order_checkout(target_order_id text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  order_row public.customer_order%ROWTYPE;
  org_created_at timestamptz;
  item_count integer;
  unique_listing_count integer;
  item_total numeric(20,0);
  item_placement_total numeric(20,0);
  item_writing_total numeric(20,0);
  existing_ledger_id text;
  balance_value numeric(20,0);
  held_value numeric(20,0);
  inserted_ledger_id text := gen_random_uuid()::text;
BEGIN
  SELECT * INTO order_row FROM public.customer_order WHERE id = target_order_id FOR UPDATE;
  IF NOT FOUND OR order_row.organization_id <> nullif(current_setting('app.organization_id', true), '')
     OR order_row.actor_user_id <> nullif(current_setting('app.user_id', true), '')
     OR NOT public.gphkm_is_active_org_member(order_row.organization_id, order_row.actor_user_id) THEN
    RAISE EXCEPTION 'order unavailable' USING ERRCODE = '42501';
  END IF;
  IF order_row.checkout_state = 'PAID' THEN
    RETURN order_row.paid_ledger_entry_id;
  END IF;
  SELECT created_at INTO org_created_at FROM public.organization WHERE id = order_row.organization_id;
  IF NOT FOUND OR NOT (
    org_created_at > now() - interval '15 days'
    OR EXISTS (SELECT 1 FROM public.access_grant g WHERE g.organization_id = order_row.organization_id
      AND g.state = 'ACTIVE' AND g.starts_at <= now() AND (g.ends_at IS NULL OR g.ends_at > now()))
  ) THEN RAISE EXCEPTION 'marketplace access required' USING ERRCODE = '42501'; END IF;
  SELECT count(*), count(DISTINCT listing_id), coalesce(sum(placement_price_minor + writing_price_minor), 0),
         coalesce(sum(placement_price_minor), 0), coalesce(sum(writing_price_minor), 0)
    INTO item_count, unique_listing_count, item_total, item_placement_total, item_writing_total
    FROM public.customer_order_item WHERE order_id = target_order_id;
  IF item_count < 1 OR item_count > 25 OR unique_listing_count <> item_count
     OR item_total <> order_row.total_minor OR item_placement_total <> order_row.placement_total_minor
     OR item_writing_total <> order_row.writing_total_minor THEN
    RAISE EXCEPTION 'order totals or item count invalid' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.customer_order_item oi
    JOIN public.marketplace_listing l ON l.id = oi.listing_id
    WHERE oi.order_id = target_order_id AND (
      l.status <> 'LIVE'
      OR NOT EXISTS (SELECT 1 FROM public.marketplace_listing_url u WHERE u.listing_id = l.id)
      OR oi.placement_price_minor <> l.retail_price_cents
      OR oi.listing_revision <> l.revision
      OR oi.writing_selected AND (NOT l.writing_enabled OR oi.writing_price_minor <> l.writing_price_cents
        OR oi.writing_first_stage_minor <> l.writing_first_draft_cents OR oi.writing_final_stage_minor <> l.writing_final_draft_cents)
      OR NOT oi.writing_selected AND (l.writing_enabled IS NULL OR oi.writing_price_minor <> 0)
      OR NOT oi.supplier_sharing_consented OR oi.consent_notice_version <> order_row.content_sharing_notice_version
      OR oi.customer_listing_snapshot <> jsonb_build_object(
        'listingId', l.id, 'revision', l.revision, 'title', l.title, 'description', l.description,
        'countryCode', l.country_code, 'primaryLanguage', l.primary_language, 'categories', l.categories,
        'retailPriceCents', l.retail_price_cents, 'linkType', l.link_type, 'linkValidity', l.link_validity,
        'turnaroundDays', l.turnaround_days, 'allowsSportsAndGaming', l.allows_sports_and_gaming,
        'allowsPharmacy', l.allows_pharmacy, 'allowsCrypto', l.allows_crypto,
        'allowsForeignLanguage', l.allows_foreign_language, 'sponsoredContentMarking', l.sponsored_content_marking,
        'writingEnabled', l.writing_enabled, 'writingPriceCents', l.writing_price_cents,
        'writingTurnaroundDays', l.writing_turnaround_days, 'writingFirstDraftCents', l.writing_first_draft_cents,
        'writingFinalDraftCents', l.writing_final_draft_cents, 'buyerRequirements', l.buyer_requirements
      )
    )
  ) THEN RAISE EXCEPTION 'listing is unavailable or order snapshot is invalid' USING ERRCODE = '23514'; END IF;

  -- Snapshot private source/cost only inside this function. Unknown costs remain provisional as NULL.
  INSERT INTO public.order_item_financial(order_item_id, commercial_source, supplier_id, fulfillment_supplier_id, source_cost_minor, writing_direct_cost_minor)
  SELECT oi.id, s.commercial_source, s.supplier_id, s.fulfillment_supplier_id, c.source_cost_cents, NULL
    FROM public.customer_order_item oi
    JOIN public.marketplace_listing l ON l.id = oi.listing_id AND l.status = 'LIVE'
    JOIN public.marketplace_listing_sourcing s ON s.listing_id = l.id
    LEFT JOIN public.marketplace_listing_cost c ON c.listing_id = l.id
   WHERE oi.order_id = target_order_id;
  IF (SELECT count(*) FROM public.order_item_financial f JOIN public.customer_order_item oi ON oi.id = f.order_item_id WHERE oi.order_id = target_order_id) <> item_count THEN
    RAISE EXCEPTION 'listing source unavailable' USING ERRCODE = '23514';
  END IF;

  SELECT balance_minor INTO balance_value FROM public.wallet_account
   WHERE organization_id = order_row.organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet unavailable' USING ERRCODE = '23514'; END IF;
  SELECT coalesce(sum(amount_minor), 0) INTO held_value FROM public.wallet_hold
   WHERE organization_id = order_row.organization_id AND state = 'ACTIVE';
  IF balance_value - held_value < order_row.total_minor THEN
    RAISE EXCEPTION 'insufficient available wallet balance' USING ERRCODE = '23514';
  END IF;

  SELECT id INTO existing_ledger_id FROM public.wallet_ledger_entry
   WHERE organization_id = order_row.organization_id AND operation = 'ORDER_CHECKOUT:' || order_row.actor_user_id
     AND idempotency_key = order_row.idempotency_key;
  IF existing_ledger_id IS NOT NULL THEN
    RAISE EXCEPTION 'checkout idempotency already consumed' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.wallet_ledger_entry(id, organization_id, actor_user_id, kind, delta_minor, currency,
    operation, idempotency_key, related_type, related_id, reason_code)
  VALUES (inserted_ledger_id, order_row.organization_id, order_row.actor_user_id, 'ORDER_DEBIT', -order_row.total_minor,
    'USD', 'ORDER_CHECKOUT:' || order_row.actor_user_id, order_row.idempotency_key, 'CUSTOMER_ORDER', order_row.id, 'ORDER_CHECKOUT');
  UPDATE public.customer_order SET checkout_state = 'PAID', paid_ledger_entry_id = inserted_ledger_id
   WHERE id = target_order_id;
  RETURN inserted_ledger_id;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_finalize_order_checkout(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_finalize_order_checkout(text) TO gphkm_runtime;
-- The creating migration role owns this definer function and the wallet table; runtime has EXECUTE only.
