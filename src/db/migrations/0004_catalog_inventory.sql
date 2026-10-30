-- Private supplier inventory and one customer-facing offer per website listing.
CREATE TYPE catalog_source AS ENUM ('PLATFORM_OWNED', 'SUPPLIER_SOURCED');
CREATE TYPE catalog_listing_status AS ENUM ('DRAFT', 'REVIEW', 'LIVE', 'PAUSED', 'ARCHIVED');
CREATE TYPE catalog_metric_provider AS ENUM ('OPEN_PAGE_RANK', 'AHREFS_DR', 'MOZ_DA');
CREATE TYPE catalog_metric_status AS ENUM ('AVAILABLE', 'MISSING', 'STALE', 'FAILED');
CREATE TYPE catalog_import_status AS ENUM ('STAGED', 'PARTIALLY_APPLIED', 'APPLIED', 'REJECTED');
CREATE TYPE catalog_import_row_status AS ENUM ('NEEDS_REVIEW', 'INVALID', 'DUPLICATE_REVIEW', 'READY', 'APPLIED', 'REJECTED');

CREATE FUNCTION public.gphkm_text_array_is_unique(values_in text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT cardinality(values_in) = count(DISTINCT item) FROM unnest(values_in) AS items(item)
$$;
REVOKE ALL ON FUNCTION public.gphkm_text_array_is_unique(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_text_array_is_unique(text[]) TO gphkm_runtime;

CREATE TABLE supplier (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  notes text,
  created_by_user_id text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE supplier_contact (
  id text PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES supplier(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  role_label text,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_contact_supplier_idx ON supplier_contact(supplier_id);
CREATE UNIQUE INDEX supplier_contact_one_primary_uq ON supplier_contact(supplier_id) WHERE is_primary;

CREATE TABLE marketplace_listing (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 4000),
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  primary_language text NOT NULL,
  categories text[] NOT NULL CHECK (cardinality(categories) BETWEEN 1 AND 7 AND array_position(categories, NULL) IS NULL AND public.gphkm_text_array_is_unique(categories)),
  retail_price_cents numeric(20,0) NOT NULL CHECK (retail_price_cents > 0),
  link_type text NOT NULL CHECK (link_type IN ('DOFOLLOW', 'NOFOLLOW', 'SPONSORED', 'UGC')),
  link_validity text NOT NULL CHECK (link_validity IN ('PERMANENT', 'FIVE_YEARS', 'ONE_YEAR', 'SIX_MONTHS', 'THREE_MONTHS')),
  turnaround_days integer NOT NULL CHECK (turnaround_days BETWEEN 1 AND 365),
  allows_sports_and_gaming boolean,
  allows_pharmacy boolean,
  allows_crypto boolean,
  allows_foreign_language boolean,
  sponsored_content_marking boolean NOT NULL,
  writing_enabled boolean NOT NULL DEFAULT false,
  writing_price_cents numeric(20,0),
  writing_turnaround_days integer,
  writing_first_draft_cents numeric(20,0),
  writing_final_draft_cents numeric(20,0),
  buyer_requirements text,
  status catalog_listing_status NOT NULL DEFAULT 'DRAFT',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_listing_writing_consistency CHECK (
    (writing_enabled = false AND writing_price_cents IS NULL AND writing_turnaround_days IS NULL
      AND writing_first_draft_cents IS NULL AND writing_final_draft_cents IS NULL)
    OR (writing_enabled = true AND writing_price_cents IS NOT NULL AND writing_price_cents >= 0
      AND writing_turnaround_days IS NOT NULL AND writing_turnaround_days BETWEEN 1 AND 365
      AND writing_first_draft_cents IS NOT NULL AND writing_final_draft_cents IS NOT NULL
      AND writing_first_draft_cents >= 0 AND writing_final_draft_cents >= 0
      AND writing_first_draft_cents + writing_final_draft_cents = writing_price_cents)
  ),
  CONSTRAINT marketplace_listing_live_policy_reviewed CHECK (status <> 'LIVE' OR
    (allows_sports_and_gaming IS NOT NULL AND allows_pharmacy IS NOT NULL AND allows_crypto IS NOT NULL AND allows_foreign_language IS NOT NULL))
);
CREATE INDEX marketplace_listing_status_idx ON marketplace_listing(status, updated_at);

CREATE TABLE marketplace_listing_sourcing (
  listing_id text PRIMARY KEY REFERENCES marketplace_listing(id),
  commercial_source catalog_source NOT NULL,
  supplier_id text REFERENCES supplier(id),
  fulfillment_supplier_id text REFERENCES supplier(id),
  url_visible_without_recharge boolean NOT NULL DEFAULT false,
  created_by_user_id text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_listing_source_supplier_consistency CHECK (
    (commercial_source = 'PLATFORM_OWNED' AND supplier_id IS NULL)
    OR (commercial_source = 'SUPPLIER_SOURCED' AND supplier_id IS NOT NULL)
  )
);
CREATE INDEX marketplace_listing_sourcing_supplier_idx ON marketplace_listing_sourcing(supplier_id);

CREATE TABLE marketplace_listing_url (
  listing_id text PRIMARY KEY REFERENCES marketplace_listing(id),
  website_url text NOT NULL CHECK (
    website_url ~ '^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?/?$'
    AND website_url !~ '^https://([0-9]{1,3}\.){3}[0-9]{1,3}/?$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketplace_listing_cost (
  listing_id text PRIMARY KEY REFERENCES marketplace_listing(id),
  source_cost_cents numeric(20,0) CHECK (source_cost_cents IS NULL OR source_cost_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.gphkm_listing_requires_sourcing() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.status = 'LIVE' AND (
    NOT EXISTS (SELECT 1 FROM public.marketplace_listing_sourcing s WHERE s.listing_id = NEW.id)
    OR NOT EXISTS (SELECT 1 FROM public.marketplace_listing_url u WHERE u.listing_id = NEW.id)
  ) THEN
    RAISE EXCEPTION 'live listing requires sourcing and URL records' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_listing_requires_sourcing() FROM PUBLIC;
CREATE TRIGGER marketplace_listing_live_requires_records BEFORE INSERT OR UPDATE ON marketplace_listing
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_listing_requires_sourcing();

CREATE TABLE marketplace_listing_revision (
  listing_id text NOT NULL REFERENCES marketplace_listing(id),
  revision integer NOT NULL CHECK (revision > 0),
  terms jsonb NOT NULL,
  actor_user_id text NOT NULL REFERENCES auth_user(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, revision)
);
CREATE INDEX marketplace_listing_revision_created_idx ON marketplace_listing_revision(listing_id, created_at);

CREATE TABLE listing_metric_observation (
  id text PRIMARY KEY,
  listing_id text NOT NULL REFERENCES marketplace_listing(id),
  provider catalog_metric_provider NOT NULL,
  metric_scope text NOT NULL DEFAULT 'REGISTERED_DOMAIN' CHECK (metric_scope IN ('REGISTERED_DOMAIN', 'DOMAIN')),
  value numeric(12,4),
  status catalog_metric_status NOT NULL,
  observed_on timestamptz,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  redistribution_approved boolean NOT NULL DEFAULT false,
  attribution_text text,
  request_id text,
  CHECK ((status IN ('AVAILABLE', 'STALE') AND value IS NOT NULL) OR (status IN ('MISSING', 'FAILED') AND value IS NULL)),
  CHECK (value IS NULL OR value >= 0)
);
CREATE INDEX listing_metric_listing_provider_date_idx ON listing_metric_observation(listing_id, provider, refreshed_at);

CREATE TABLE catalog_import_batch (
  id text PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES supplier(id),
  source_type text NOT NULL CHECK (source_type IN ('CSV', 'XLSX', 'GOOGLE_SHEETS')),
  source_reference text,
  source_filename text CHECK (source_filename IS NULL OR length(source_filename) <= 255),
  source_object_key text,
  source_bytes integer,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  mapping jsonb NOT NULL CHECK (jsonb_typeof(mapping) = 'object'),
  status catalog_import_status NOT NULL DEFAULT 'STAGED',
  created_by_user_id text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CHECK ((source_object_key IS NULL AND source_bytes IS NULL) OR (source_object_key IS NOT NULL AND source_bytes IS NOT NULL AND source_bytes BETWEEN 1 AND 10485760)),
  CHECK (source_object_key IS NULL OR (length(source_object_key) BETWEEN 1 AND 512 AND source_object_key !~ '^https?://')),
  CHECK ((status IN ('PARTIALLY_APPLIED', 'APPLIED') AND applied_at IS NOT NULL) OR (status IN ('STAGED', 'REJECTED') AND applied_at IS NULL))
);
CREATE INDEX catalog_import_batch_supplier_created_idx ON catalog_import_batch(supplier_id, created_at);

CREATE TABLE catalog_import_row (
  id text PRIMARY KEY,
  batch_id text NOT NULL REFERENCES catalog_import_batch(id),
  row_number integer NOT NULL CHECK (row_number > 0),
  original_values jsonb NOT NULL,
  staged_values jsonb NOT NULL,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  duplicate_of_row integer,
  duplicate_of_listing_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  duplicate_decision text,
  duplicate_reason text,
  duplicate_decided_by_user_id text REFERENCES auth_user(id),
  duplicate_decided_at timestamptz,
  status catalog_import_row_status NOT NULL DEFAULT 'NEEDS_REVIEW',
  applied_listing_id text REFERENCES marketplace_listing(id),
  reviewed_by_user_id text REFERENCES auth_user(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, row_number),
  CHECK (jsonb_typeof(original_values) = 'object' AND jsonb_typeof(staged_values) = 'object'
    AND NOT (original_values ? 'sourceCostCents') AND NOT (staged_values ? 'sourceCostCents')),
  CHECK (jsonb_typeof(errors) = 'array' AND jsonb_typeof(warnings) = 'array' AND jsonb_typeof(duplicate_of_listing_ids) = 'array'),
  CHECK (
    (duplicate_decision IS NULL AND duplicate_reason IS NULL AND duplicate_decided_by_user_id IS NULL AND duplicate_decided_at IS NULL)
    OR (duplicate_decision IN ('KEEP_SEPARATE', 'REJECT') AND duplicate_reason IS NOT NULL AND length(btrim(duplicate_reason)) > 0
      AND duplicate_decided_by_user_id IS NOT NULL AND duplicate_decided_at IS NOT NULL)
  ),
  CHECK ((status = 'APPLIED' AND applied_listing_id IS NOT NULL) OR (status <> 'APPLIED' AND applied_listing_id IS NULL))
);
CREATE INDEX catalog_import_row_status_idx ON catalog_import_row(batch_id, status);

CREATE TABLE catalog_import_cost (
  id text PRIMARY KEY,
  batch_id text NOT NULL REFERENCES catalog_import_batch(id),
  row_number integer NOT NULL CHECK (row_number > 0),
  source_cost_cents numeric(20,0) CHECK (source_cost_cents IS NULL OR source_cost_cents >= 0),
  actor_user_id text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, row_number)
);
ALTER TABLE catalog_import_cost ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON catalog_import_cost TO gphkm_runtime;
REVOKE DELETE ON catalog_import_cost FROM gphkm_runtime;
CREATE POLICY catalog_import_cost_finance_read ON catalog_import_cost FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
CREATE POLICY catalog_import_cost_finance_insert ON catalog_import_cost FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id', true), '') AND (
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE')
    OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN'))
);
CREATE POLICY catalog_import_cost_finance_update ON catalog_import_cost FOR UPDATE TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
) WITH CHECK (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);

CREATE TABLE catalog_import_apply_event (
  id text PRIMARY KEY,
  batch_id text NOT NULL REFERENCES catalog_import_batch(id),
  actor_user_id text NOT NULL REFERENCES auth_user(id),
  selected_row_ids jsonb NOT NULL CHECK (jsonb_typeof(selected_row_ids) = 'array'),
  applied_listing_ids jsonb NOT NULL CHECK (jsonb_typeof(applied_listing_ids) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Customer code uses the explicit allowlist projection in src/modules/catalog/domain.ts.
-- The shared runtime role must still enforce that projection at every serialization boundary.
ALTER TABLE supplier ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_listing ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_listing_sourcing ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_listing_url ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_listing_cost ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_listing_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_metric_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_import_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_import_apply_event ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON supplier, supplier_contact, marketplace_listing,
  marketplace_listing_sourcing, marketplace_listing_url, marketplace_listing_cost,
  marketplace_listing_revision, listing_metric_observation, catalog_import_batch,
  catalog_import_row, catalog_import_cost, catalog_import_apply_event TO gphkm_runtime;
REVOKE DELETE ON supplier, supplier_contact, marketplace_listing, marketplace_listing_revision,
  marketplace_listing_sourcing, marketplace_listing_url, marketplace_listing_cost,
  listing_metric_observation, catalog_import_batch, catalog_import_row, catalog_import_cost, catalog_import_apply_event FROM gphkm_runtime;
REVOKE UPDATE ON marketplace_listing_revision, listing_metric_observation, catalog_import_apply_event FROM gphkm_runtime;

CREATE POLICY supplier_staff_read ON supplier FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
);
CREATE POLICY supplier_staff_insert ON supplier FOR INSERT TO gphkm_runtime WITH CHECK (
  created_by_user_id = nullif(current_setting('app.user_id', true), '')
  AND EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
);
CREATE POLICY supplier_staff_update ON supplier FOR UPDATE TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
);
CREATE POLICY supplier_contact_staff_access ON supplier_contact FOR ALL TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
);

CREATE POLICY marketplace_listing_read ON marketplace_listing FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'FINANCE', 'SUPER_ADMIN'))
  OR (status = 'LIVE'
    AND nullif(current_setting('app.organization_id', true), '') IS NOT NULL
    AND public.gphkm_is_active_org_member(nullif(current_setting('app.organization_id', true), ''), nullif(current_setting('app.user_id', true), ''))
    AND EXISTS (SELECT 1 FROM organization o WHERE o.id = nullif(current_setting('app.organization_id', true), '')
      AND (o.created_at > now() - interval '15 days'
        OR EXISTS (SELECT 1 FROM access_grant g WHERE g.organization_id = o.id AND g.state = 'ACTIVE'
          AND g.starts_at <= now() AND (g.ends_at IS NULL OR g.ends_at > now())))))
);
CREATE POLICY marketplace_listing_staff_insert ON marketplace_listing FOR INSERT TO gphkm_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
);
CREATE POLICY marketplace_listing_staff_update ON marketplace_listing FOR UPDATE TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
);

CREATE POLICY marketplace_listing_sourcing_staff_read ON marketplace_listing_sourcing FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'ADMIN')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
CREATE POLICY marketplace_listing_sourcing_staff_insert ON marketplace_listing_sourcing FOR INSERT TO gphkm_runtime WITH CHECK (
  created_by_user_id = nullif(current_setting('app.user_id', true), '')
  AND (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'ADMIN')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN'))
);
CREATE POLICY marketplace_listing_sourcing_staff_update ON marketplace_listing_sourcing FOR UPDATE TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'ADMIN')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
) WITH CHECK (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'ADMIN')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);

CREATE FUNCTION public.gphkm_customer_can_read_listing_url(target_listing text, target_org text, target_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.marketplace_listing l
      JOIN public.marketplace_listing_sourcing s ON s.listing_id = l.id
      JOIN public.marketplace_listing_url u ON u.listing_id = l.id
      JOIN public.organization o ON o.id = target_org
     WHERE l.id = target_listing AND l.status = 'LIVE'
       AND public.gphkm_is_active_org_member(target_org, target_user)
       AND (o.created_at > now() - interval '15 days'
         OR EXISTS (SELECT 1 FROM public.access_grant g WHERE g.organization_id = o.id AND g.state = 'ACTIVE'
           AND g.starts_at <= now() AND (g.ends_at IS NULL OR g.ends_at > now())))
       AND (s.url_visible_without_recharge OR EXISTS (
         SELECT 1 FROM public.access_grant g WHERE g.organization_id = o.id AND g.state = 'ACTIVE'
           AND g.starts_at <= now() AND (g.ends_at IS NULL OR g.ends_at > now())))
  )
$$;
REVOKE ALL ON FUNCTION public.gphkm_customer_can_read_listing_url(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_customer_can_read_listing_url(text, text, text) TO gphkm_runtime;
CREATE POLICY marketplace_listing_url_staff_read ON marketplace_listing_url FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'ADMIN')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
CREATE POLICY marketplace_listing_url_staff_insert ON marketplace_listing_url FOR INSERT TO gphkm_runtime WITH CHECK (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'ADMIN')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
CREATE POLICY marketplace_listing_url_staff_update ON marketplace_listing_url FOR UPDATE TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'ADMIN')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
) WITH CHECK (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'ADMIN')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
CREATE POLICY marketplace_listing_url_customer_read ON marketplace_listing_url FOR SELECT TO gphkm_runtime USING (
  public.gphkm_customer_can_read_listing_url(listing_id,
    nullif(current_setting('app.organization_id', true), ''), nullif(current_setting('app.user_id', true), ''))
);

CREATE POLICY marketplace_listing_cost_finance_read ON marketplace_listing_cost FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
CREATE POLICY marketplace_listing_cost_finance_insert ON marketplace_listing_cost FOR INSERT TO gphkm_runtime WITH CHECK (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
CREATE POLICY marketplace_listing_cost_finance_update ON marketplace_listing_cost FOR UPDATE TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
) WITH CHECK (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE')
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
CREATE POLICY marketplace_listing_revision_staff_read ON marketplace_listing_revision FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
);
CREATE POLICY marketplace_listing_revision_staff_insert ON marketplace_listing_revision FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id', true), '')
  AND EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
);
CREATE POLICY listing_metric_staff_access ON listing_metric_observation FOR ALL TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
);
CREATE POLICY listing_metric_customer_read ON listing_metric_observation FOR SELECT TO gphkm_runtime USING (
  redistribution_approved AND attribution_text IS NOT NULL AND status = 'AVAILABLE'
  AND EXISTS (SELECT 1 FROM marketplace_listing l WHERE l.id = listing_metric_observation.listing_id AND l.status = 'LIVE')
  AND EXISTS (SELECT 1 FROM organization o
    WHERE o.id = nullif(current_setting('app.organization_id', true), '')
      AND public.gphkm_is_active_org_member(o.id, nullif(current_setting('app.user_id', true), ''))
      AND (o.created_at > now() - interval '15 days'
        OR EXISTS (SELECT 1 FROM access_grant g WHERE g.organization_id = o.id AND g.state = 'ACTIVE'
          AND g.starts_at <= now() AND (g.ends_at IS NULL OR g.ends_at > now()))))
);

CREATE POLICY catalog_import_batch_staff_read ON catalog_import_batch FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
);
CREATE POLICY catalog_import_batch_staff_insert ON catalog_import_batch FOR INSERT TO gphkm_runtime WITH CHECK (
  created_by_user_id = nullif(current_setting('app.user_id', true), '')
  AND EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
);
CREATE POLICY catalog_import_batch_staff_update ON catalog_import_batch FOR UPDATE TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
);
CREATE POLICY catalog_import_row_staff_access ON catalog_import_row FOR ALL TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
);
CREATE POLICY catalog_import_apply_event_staff_read ON catalog_import_apply_event FOR SELECT TO gphkm_runtime USING (
  EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
);
CREATE POLICY catalog_import_apply_event_staff_insert ON catalog_import_apply_event FOR INSERT TO gphkm_runtime WITH CHECK (
  actor_user_id = nullif(current_setting('app.user_id', true), '')
  AND EXISTS (SELECT 1 FROM staff_account s WHERE s.user_id = nullif(current_setting('app.user_id', true), '')
    AND s.active AND s.role IN ('ADMIN', 'SUPER_ADMIN'))
);

-- Revisions and observations are append-only; applied import rows cannot be rewritten.
CREATE FUNCTION public.gphkm_catalog_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'catalog evidence is immutable' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_catalog_immutable() FROM PUBLIC;
CREATE TRIGGER marketplace_listing_revision_immutable BEFORE UPDATE OR DELETE ON marketplace_listing_revision
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_catalog_immutable();
CREATE TRIGGER listing_metric_observation_immutable BEFORE UPDATE OR DELETE ON listing_metric_observation
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_catalog_immutable();
CREATE TRIGGER catalog_import_apply_event_immutable BEFORE UPDATE OR DELETE ON catalog_import_apply_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_catalog_immutable();

CREATE FUNCTION public.gphkm_catalog_import_row_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status = 'APPLIED' OR OLD.applied_listing_id IS NOT NULL THEN
    RAISE EXCEPTION 'applied import rows are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_catalog_import_row_guard() FROM PUBLIC;
CREATE TRIGGER catalog_import_row_applied_immutable BEFORE UPDATE OR DELETE ON catalog_import_row
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_catalog_import_row_guard();
