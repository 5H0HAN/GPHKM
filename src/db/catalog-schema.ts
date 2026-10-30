import { sql } from "drizzle-orm";
import { bigserial, boolean, check, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./schema";

export const catalogSource = pgEnum("catalog_source", ["PLATFORM_OWNED", "SUPPLIER_SOURCED"]);
export const catalogListingStatus = pgEnum("catalog_listing_status", ["DRAFT", "REVIEW", "LIVE", "PAUSED", "ARCHIVED"]);
export const catalogMetricProvider = pgEnum("catalog_metric_provider", ["OPEN_PAGE_RANK", "AHREFS_DR", "MOZ_DA"]);
export const catalogMetricStatus = pgEnum("catalog_metric_status", ["AVAILABLE", "MISSING", "STALE", "FAILED"]);
export const catalogImportStatus = pgEnum("catalog_import_status", ["STAGED", "PARTIALLY_APPLIED", "APPLIED", "REJECTED"]);
export const catalogImportRowStatus = pgEnum("catalog_import_row_status", ["NEEDS_REVIEW", "INVALID", "DUPLICATE_REVIEW", "READY", "APPLIED", "REJECTED"]);

export const supplier = pgTable("supplier", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull().default("ACTIVE"),
  notes: text("notes"),
  createdByUserId: text("created_by_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("supplier_name_length", sql`length(btrim(${t.name})) between 1 and 160`),
  check("supplier_status_valid", sql`${t.status} in ('ACTIVE', 'INACTIVE')`),
]).enableRLS();

export const supplierContact = pgTable("supplier_contact", {
  id: text("id").primaryKey(),
  supplierId: text("supplier_id").notNull().references(() => supplier.id),
  name: text("name").notNull(),
  email: text("email").notNull(),
  roleLabel: text("role_label"),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("supplier_contact_supplier_idx").on(t.supplierId),
  uniqueIndex("supplier_contact_one_primary_uq").on(t.supplierId).where(sql`${t.isPrimary}`),
  check("supplier_contact_name_length", sql`length(btrim(${t.name})) between 1 and 160`),
  check("supplier_contact_email_length", sql`length(${t.email}) between 3 and 320`),
]).enableRLS();

export const listing = pgTable("marketplace_listing", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  countryCode: text("country_code").notNull(),
  primaryLanguage: text("primary_language").notNull(),
  categories: text("categories").array().notNull(),
  retailPriceCents: numeric("retail_price_cents", { precision: 20, scale: 0 }).notNull(),
  linkType: text("link_type").notNull(),
  linkValidity: text("link_validity").notNull(),
  turnaroundDays: integer("turnaround_days").notNull(),
  allowsSportsAndGaming: boolean("allows_sports_and_gaming"),
  allowsPharmacy: boolean("allows_pharmacy"),
  allowsCrypto: boolean("allows_crypto"),
  allowsForeignLanguage: boolean("allows_foreign_language"),
  sponsoredContentMarking: boolean("sponsored_content_marking").notNull(),
  writingEnabled: boolean("writing_enabled").notNull().default(false),
  writingPriceCents: numeric("writing_price_cents", { precision: 20, scale: 0 }),
  writingTurnaroundDays: integer("writing_turnaround_days"),
  writingFirstDraftCents: numeric("writing_first_draft_cents", { precision: 20, scale: 0 }),
  writingFinalDraftCents: numeric("writing_final_draft_cents", { precision: 20, scale: 0 }),
  buyerRequirements: text("buyer_requirements"),
  status: catalogListingStatus("status").notNull().default("DRAFT"),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("marketplace_listing_status_idx").on(t.status, t.updatedAt),
  check("marketplace_listing_title_length", sql`length(btrim(${t.title})) between 1 and 120`),
  check("marketplace_listing_description_length", sql`length(${t.description}) between 1 and 4000`),
  check("marketplace_listing_country_code", sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
  check("marketplace_listing_categories_count", sql`cardinality(${t.categories}) between 1 and 7 and array_position(${t.categories}, null) is null`),
  check("marketplace_listing_categories_unique", sql`public.gphkm_text_array_is_unique(${t.categories})`),
  check("marketplace_listing_price_positive", sql`${t.retailPriceCents} > 0`),
  check("marketplace_listing_link_type", sql`${t.linkType} in ('DOFOLLOW', 'NOFOLLOW', 'SPONSORED', 'UGC')`),
  check("marketplace_listing_link_validity", sql`${t.linkValidity} in ('PERMANENT', 'FIVE_YEARS', 'ONE_YEAR', 'SIX_MONTHS', 'THREE_MONTHS')`),
  check("marketplace_listing_turnaround", sql`${t.turnaroundDays} between 1 and 365`),
  check("marketplace_listing_writing_consistency", sql`(
    (${t.writingEnabled} = false and ${t.writingPriceCents} is null and ${t.writingTurnaroundDays} is null
      and ${t.writingFirstDraftCents} is null and ${t.writingFinalDraftCents} is null)
    or (${t.writingEnabled} = true and ${t.writingPriceCents} is not null and ${t.writingPriceCents} >= 0
      and ${t.writingTurnaroundDays} is not null and ${t.writingTurnaroundDays} between 1 and 365
      and ${t.writingFirstDraftCents} is not null and ${t.writingFinalDraftCents} is not null
      and ${t.writingFirstDraftCents} >= 0 and ${t.writingFinalDraftCents} >= 0
      and ${t.writingFirstDraftCents} + ${t.writingFinalDraftCents} = ${t.writingPriceCents})
  )`),
  check("marketplace_listing_live_policy_reviewed", sql`${t.status} <> 'LIVE' or (${t.allowsSportsAndGaming} is not null and ${t.allowsPharmacy} is not null and ${t.allowsCrypto} is not null and ${t.allowsForeignLanguage} is not null)`),
  check("marketplace_listing_revision_positive", sql`${t.revision} > 0`),
]).enableRLS();

// Confidential sourcing and URL values are kept outside customer-readable offer terms.
export const listingSourcing = pgTable("marketplace_listing_sourcing", {
  listingId: text("listing_id").primaryKey().references(() => listing.id),
  commercialSource: catalogSource("commercial_source").notNull(),
  supplierId: text("supplier_id").references(() => supplier.id),
  fulfillmentSupplierId: text("fulfillment_supplier_id").references(() => supplier.id),
  urlVisibleWithoutRecharge: boolean("url_visible_without_recharge").notNull().default(false),
  createdByUserId: text("created_by_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("marketplace_listing_sourcing_supplier_idx").on(t.supplierId),
  check("marketplace_listing_source_supplier_consistency", sql`(
    (${t.commercialSource} = 'PLATFORM_OWNED' and ${t.supplierId} is null)
    or (${t.commercialSource} = 'SUPPLIER_SOURCED' and ${t.supplierId} is not null)
  )`),
  check("marketplace_listing_supplier_identity_consistency", sql`${t.supplierId} is null or (${t.fulfillmentSupplierId} is not null and ${t.supplierId} = ${t.fulfillmentSupplierId})`),
]).enableRLS();

export const listingUrl = pgTable("marketplace_listing_url", {
  listingId: text("listing_id").primaryKey().references(() => listing.id),
  websiteUrl: text("website_url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("marketplace_listing_website_url", sql`${t.websiteUrl} ~ '^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?/?$' and ${t.websiteUrl} !~ '^https://([0-9]{1,3}\\.){3}[0-9]{1,3}/?$'`),
]).enableRLS();

export const listingCost = pgTable("marketplace_listing_cost", {
  listingId: text("listing_id").primaryKey().references(() => listing.id),
  sourceCostCents: numeric("source_cost_cents", { precision: 20, scale: 0 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("marketplace_listing_source_cost_nonnegative", sql`${t.sourceCostCents} is null or ${t.sourceCostCents} >= 0`),
]).enableRLS();

// Frozen customer-facing offer terms, excluding all sourcing and cost fields.
export const listingRevision = pgTable("marketplace_listing_revision", {
  listingId: text("listing_id").notNull().references(() => listing.id),
  revision: integer("revision").notNull(),
  terms: jsonb("terms").$type<Record<string, unknown>>().notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("marketplace_listing_revision_created_idx").on(t.listingId, t.createdAt),
]).enableRLS();

export const listingMetricObservation = pgTable("listing_metric_observation", {
  id: text("id").primaryKey(),
  listingId: text("listing_id").notNull().references(() => listing.id),
  provider: catalogMetricProvider("provider").notNull(),
  metricScope: text("metric_scope").notNull().default("REGISTERED_DOMAIN"),
  metricTarget: text("metric_target"),
  requestedTarget: text("requested_target"),
  value: numeric("value", { precision: 12, scale: 4 }),
  status: catalogMetricStatus("status").notNull(),
  observedOn: timestamp("observed_on", { withTimezone: true }),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
  source: text("source").notNull(),
  redistributionApproved: boolean("redistribution_approved").notNull().default(false),
  attributionText: text("attribution_text"),
  requestId: text("request_id"),
}, (t) => [
  index("listing_metric_listing_provider_date_idx").on(t.listingId, t.provider, t.refreshedAt),
  check("listing_metric_scope_valid", sql`${t.metricScope} in ('REGISTERED_DOMAIN', 'DOMAIN', 'HOST')`),
  check("listing_metric_target_valid", sql`${t.metricTarget} is null or ${t.metricTarget} ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$'`),
  check("listing_metric_requested_target_valid", sql`${t.requestedTarget} is null or ${t.requestedTarget} ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$'`),
  check("listing_metric_status_value", sql`(${t.status} in ('AVAILABLE', 'STALE') and ${t.value} is not null) or (${t.status} in ('MISSING', 'FAILED') and ${t.value} is null)`),
  check("listing_metric_value_nonnegative", sql`${t.value} is null or ${t.value} >= 0`),
]).enableRLS();

export const listingMetricApprovalEvent = pgTable("listing_metric_approval_event", {
  id: text("id").primaryKey(),
  eventSequence: bigserial("event_sequence", { mode: "number" }).notNull().unique(),
  observationId: text("observation_id").notNull().references(() => listingMetricObservation.id),
  listingId: text("listing_id").notNull().references(() => listing.id),
  provider: catalogMetricProvider("provider").notNull(),
  decision: text("decision").notNull(),
  attributionText: text("attribution_text"),
  evidenceReference: text("evidence_reference").notNull(),
  reason: text("reason").notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("listing_metric_approval_latest_idx").on(t.observationId, t.createdAt, t.id),
  check("listing_metric_approval_decision_valid", sql`${t.decision} in ('APPROVED', 'REVOKED')`),
  check("listing_metric_approval_attribution", sql`(${t.decision} = 'APPROVED' and ${t.attributionText} is not null and length(btrim(${t.attributionText})) between 1 and 300) or (${t.decision} = 'REVOKED' and ${t.attributionText} is null)`),
  check("listing_metric_approval_evidence_reference_length", sql`length(btrim(${t.evidenceReference})) between 5 and 500`),
  check("listing_metric_approval_reason_length", sql`length(btrim(${t.reason})) between 5 and 1000`),
]).enableRLS();

export const catalogImportBatch = pgTable("catalog_import_batch", {
  id: text("id").primaryKey(),
  supplierId: text("supplier_id").notNull().references(() => supplier.id),
  sourceType: text("source_type").notNull(),
  sourceReference: text("source_reference"),
  sourceFilename: text("source_filename"),
  sourceObjectKey: text("source_object_key"),
  sourceBytes: integer("source_bytes"),
  contentSha256: text("content_sha256").notNull(),
  mapping: jsonb("mapping").$type<Record<string, number>>().notNull(),
  status: catalogImportStatus("status").notNull().default("STAGED"),
  createdByUserId: text("created_by_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
}, (t) => [
  index("catalog_import_batch_supplier_created_idx").on(t.supplierId, t.createdAt),
  check("catalog_import_source_type", sql`${t.sourceType} in ('CSV', 'XLSX', 'GOOGLE_SHEETS')`),
  check("catalog_import_sha256", sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
  check("catalog_import_filename_length", sql`${t.sourceFilename} is null or length(${t.sourceFilename}) <= 255`),
  check("catalog_import_source_file_metadata", sql`(${t.sourceObjectKey} is null and ${t.sourceBytes} is null) or (${t.sourceObjectKey} is not null and ${t.sourceBytes} between 1 and 10485760)`),
  check("catalog_import_source_object_key", sql`${t.sourceObjectKey} is null or (length(${t.sourceObjectKey}) between 1 and 512 and ${t.sourceObjectKey} !~ '^https?://')`),
  check("catalog_import_applied_at", sql`(${t.status} in ('PARTIALLY_APPLIED', 'APPLIED') and ${t.appliedAt} is not null) or (${t.status} in ('STAGED', 'REJECTED') and ${t.appliedAt} is null)`),
  check("catalog_import_mapping_object", sql`jsonb_typeof(${t.mapping}) = 'object'`),
]).enableRLS();

export const catalogImportRow = pgTable("catalog_import_row", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull().references(() => catalogImportBatch.id),
  rowNumber: integer("row_number").notNull(),
  originalValues: jsonb("original_values").$type<Record<string, unknown>>().notNull(),
  stagedValues: jsonb("staged_values").$type<Record<string, unknown>>().notNull(),
  errors: jsonb("errors").$type<Array<{ field: string; code: string }>>().notNull().default([]),
  warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
  duplicateOfRow: integer("duplicate_of_row"),
  duplicateOfListingIds: jsonb("duplicate_of_listing_ids").$type<string[]>().notNull().default([]),
  duplicateDecision: text("duplicate_decision"),
  duplicateReason: text("duplicate_reason"),
  duplicateDecidedByUserId: text("duplicate_decided_by_user_id").references(() => user.id),
  duplicateDecidedAt: timestamp("duplicate_decided_at", { withTimezone: true }),
  status: catalogImportRowStatus("status").notNull().default("NEEDS_REVIEW"),
  appliedListingId: text("applied_listing_id").references(() => listing.id),
  reviewedByUserId: text("reviewed_by_user_id").references(() => user.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("catalog_import_row_batch_number_uq").on(t.batchId, t.rowNumber),
  index("catalog_import_row_status_idx").on(t.batchId, t.status),
  check("catalog_import_row_number_positive", sql`${t.rowNumber} > 0`),
  check("catalog_import_row_json_shapes", sql`jsonb_typeof(${t.originalValues}) = 'object' and jsonb_typeof(${t.stagedValues}) = 'object' and jsonb_typeof(${t.errors}) = 'array' and jsonb_typeof(${t.warnings}) = 'array' and jsonb_typeof(${t.duplicateOfListingIds}) = 'array'`),
  check("catalog_import_duplicate_resolution", sql`(
    ${t.duplicateDecision} is null and ${t.duplicateReason} is null and ${t.duplicateDecidedByUserId} is null and ${t.duplicateDecidedAt} is null
    or ${t.duplicateDecision} in ('KEEP_SEPARATE', 'REJECT') and ${t.duplicateReason} is not null and length(btrim(${t.duplicateReason})) > 0
      and ${t.duplicateDecidedByUserId} is not null and ${t.duplicateDecidedAt} is not null
  )`),
  check("catalog_import_applied_listing", sql`(${t.status} = 'APPLIED' and ${t.appliedListingId} is not null) or (${t.status} <> 'APPLIED' and ${t.appliedListingId} is null)`),
]).enableRLS();

// Imported source costs are stored outside Admin-readable row JSON.
export const catalogImportCost = pgTable("catalog_import_cost", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull().references(() => catalogImportBatch.id),
  rowNumber: integer("row_number").notNull(),
  sourceCostCents: numeric("source_cost_cents", { precision: 20, scale: 0 }),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("catalog_import_cost_batch_row_uq").on(t.batchId, t.rowNumber),
  check("catalog_import_cost_row_number", sql`${t.rowNumber} > 0`),
  check("catalog_import_cost_nonnegative", sql`${t.sourceCostCents} is null or ${t.sourceCostCents} >= 0`),
]).enableRLS();

export const catalogImportApplyEvent = pgTable("catalog_import_apply_event", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull().references(() => catalogImportBatch.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  selectedRowIds: jsonb("selected_row_ids").$type<string[]>().notNull(),
  appliedListingIds: jsonb("applied_listing_ids").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("catalog_import_apply_event_json_arrays", sql`jsonb_typeof(${t.selectedRowIds}) = 'array' and jsonb_typeof(${t.appliedListingIds}) = 'array'`),
]).enableRLS();
