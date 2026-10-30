import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organization, user, walletLedgerEntry } from "./schema";
import { listing, supplier } from "./catalog-schema";

export const customerOrder = pgTable("customer_order", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  currency: text("currency").notNull().default("USD"),
  placementTotalMinor: numeric("placement_total_minor", { precision: 20, scale: 0 }).notNull(),
  writingTotalMinor: numeric("writing_total_minor", { precision: 20, scale: 0 }).notNull(),
  totalMinor: numeric("total_minor", { precision: 20, scale: 0 }).notNull(),
  customerStatus: text("customer_status").notNull().default("ORDER_RECEIVED"),
  checkoutState: text("checkout_state").notNull().default("PENDING_POST"),
  contentSharingNoticeVersion: text("content_sharing_notice_version").notNull(),
  contentPolicyVersion: text("content_policy_version"),
  contentPolicyAcceptedAt: timestamp("content_policy_accepted_at", { withTimezone: true }),
  paidLedgerEntryId: text("paid_ledger_entry_id").references(() => walletLedgerEntry.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("customer_order_org_actor_idem_uq").on(t.organizationId, t.actorUserId, t.idempotencyKey),
  index("customer_order_org_created_idx").on(t.organizationId, t.createdAt),
  check("customer_order_usd_only", sql`${t.currency} = 'USD'`),
  check("customer_order_totals_valid", sql`${t.placementTotalMinor} >= 0 and ${t.writingTotalMinor} >= 0 and ${t.totalMinor} > 0 and ${t.totalMinor} = ${t.placementTotalMinor} + ${t.writingTotalMinor}`),
  check("customer_order_idempotency_valid", sql`length(${t.idempotencyKey}) between 16 and 128 and ${t.requestHash} ~ '^[0-9a-f]{64}$'`),
  check("customer_order_checkout_state_valid", sql`(${t.checkoutState} = 'PENDING_POST' and ${t.paidLedgerEntryId} is null) or (${t.checkoutState} = 'PAID' and ${t.paidLedgerEntryId} is not null)`),
  check("customer_order_status_valid", sql`${t.customerStatus} in ('ORDER_RECEIVED', 'CONTENT_REVIEW', 'PREPARING', 'IN_PROGRESS', 'LINK_VERIFICATION', 'COMPLETE', 'RESOLVED')`),
  check("customer_order_content_policy_snapshot_valid", sql`(${t.contentPolicyVersion} is null and ${t.contentPolicyAcceptedAt} is null) or (${t.contentPolicyVersion} = 'gphkm-content-policy-v1' and ${t.contentPolicyAcceptedAt} is not null)`),
]).enableRLS();

export const customerOrderItem = pgTable("customer_order_item", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => customerOrder.id),
  listingId: text("listing_id").notNull().references(() => listing.id),
  listingRevision: integer("listing_revision").notNull(),
  customerListingSnapshot: jsonb("customer_listing_snapshot").$type<Record<string, unknown>>().notNull(),
  placementPriceMinor: numeric("placement_price_minor", { precision: 20, scale: 0 }).notNull(),
  writingSelected: boolean("writing_selected").notNull(),
  writingPriceMinor: numeric("writing_price_minor", { precision: 20, scale: 0 }).notNull().default("0"),
  writingFirstStageMinor: numeric("writing_first_stage_minor", { precision: 20, scale: 0 }).notNull().default("0"),
  writingFinalStageMinor: numeric("writing_final_stage_minor", { precision: 20, scale: 0 }).notNull().default("0"),
  targetUrl: text("target_url").notNull(),
  anchorText: text("anchor_text").notNull(),
  instructions: text("instructions").notNull().default(""),
  articleText: text("article_text"),
  writingBrief: text("writing_brief"),
  supplierSharingConsented: boolean("supplier_sharing_consented").notNull(),
  consentedAt: timestamp("consented_at", { withTimezone: true }).notNull().defaultNow(),
  consentNoticeVersion: text("consent_notice_version").notNull(),
  customerStatus: text("customer_status").notNull().default("ORDER_RECEIVED"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("customer_order_item_order_listing_uq").on(t.orderId, t.listingId),
  index("customer_order_item_listing_idx").on(t.listingId, t.createdAt),
  check("customer_order_item_price_valid", sql`${t.placementPriceMinor} > 0 and ${t.writingPriceMinor} >= 0 and ${t.writingFirstStageMinor} >= 0 and ${t.writingFinalStageMinor} >= 0 and ${t.writingPriceMinor} = ${t.writingFirstStageMinor} + ${t.writingFinalStageMinor}`),
  check("customer_order_item_target_url_safe", sql`${t.targetUrl} ~* '^https?://[^/?#[:space:]]+([/?#].*)?$' and ${t.targetUrl} !~* '^https?://[^/@?#]+@' and ${t.targetUrl} !~ '[[:cntrl:][:space:]]'`),
  check("customer_order_item_writing_valid", sql`(not ${t.writingSelected} and ${t.writingPriceMinor} = 0 and ${t.writingFirstStageMinor} = 0 and ${t.writingFinalStageMinor} = 0 and ${t.articleText} is not null and ${t.writingBrief} is null) or (${t.writingSelected} and ${t.writingBrief} is not null and ${t.articleText} is null)`),
  check("customer_order_item_consent_valid", sql`${t.supplierSharingConsented} and length(${t.consentNoticeVersion}) between 1 and 80`),
  check("customer_order_item_text_bounds", sql`length(${t.targetUrl}) between 1 and 2048 and length(${t.anchorText}) between 1 and 200 and length(${t.instructions}) <= 4000 and (${t.articleText} is null or length(${t.articleText}) between 1 and 20000) and (${t.writingBrief} is null or length(${t.writingBrief}) between 1 and 4000)`),
  check("customer_order_item_status_valid", sql`${t.customerStatus} in ('ORDER_RECEIVED', 'CONTENT_REVIEW', 'PREPARING', 'IN_PROGRESS', 'LINK_VERIFICATION', 'COMPLETE', 'RESOLVED')`),
]).enableRLS();

// Internal margin inputs are isolated from customer-readable order rows.
export const orderItemFinancial = pgTable("order_item_financial", {
  orderItemId: text("order_item_id").primaryKey().references(() => customerOrderItem.id),
  commercialSource: text("commercial_source").notNull(),
  supplierId: text("supplier_id").references(() => supplier.id),
  fulfillmentSupplierId: text("fulfillment_supplier_id").references(() => supplier.id),
  sourceCostMinor: numeric("source_cost_minor", { precision: 20, scale: 0 }),
  writingDirectCostMinor: numeric("writing_direct_cost_minor", { precision: 20, scale: 0 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("order_item_financial_source_valid", sql`(${t.commercialSource} = 'PLATFORM_OWNED' and ${t.supplierId} is null) or (${t.commercialSource} = 'SUPPLIER_SOURCED' and ${t.supplierId} is not null)`),
  check("order_item_financial_supplier_identity_consistency", sql`${t.supplierId} is null or (${t.fulfillmentSupplierId} is not null and ${t.supplierId} = ${t.fulfillmentSupplierId})`),
  check("order_item_financial_cost_valid", sql`(${t.sourceCostMinor} is null or ${t.sourceCostMinor} >= 0) and (${t.writingDirectCostMinor} is null or ${t.writingDirectCostMinor} >= 0)`),
]).enableRLS();

// Operational fulfillment snapshot is separate from finance data and frozen order content.
export const orderItemFulfillment = pgTable("order_item_fulfillment", {
  orderItemId: text("order_item_id").primaryKey().references(() => customerOrderItem.id),
  orderId: text("order_id").notNull().references(() => customerOrder.id),
  listingTitle: text("listing_title").notNull(),
  state: text("state").notNull().default("CONFIRMED"),
  assignedAdminId: text("assigned_admin_id").references(() => user.id),
  stateBeforeHold: text("state_before_hold"),
  stateBeforeCancellation: text("state_before_cancellation"),
  customerStatus: text("customer_status").notNull().default("ORDER_RECEIVED"),
  nextUpdateAt: timestamp("next_update_at", { withTimezone: true }),
  workStartedAt: timestamp("work_started_at", { withTimezone: true }),
  handedOffAt: timestamp("handed_off_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("order_item_fulfillment_assignee_idx").on(t.assignedAdminId, t.state, t.updatedAt),
  index("order_item_fulfillment_order_idx").on(t.orderId),
]).enableRLS();

// Customer-safe status snapshots are recorded only when the public milestone or
// its next-update date changes. Internal workflow states and staff notes are
// intentionally absent from this immutable history.
export const customerOrderItemMilestone = pgTable("customer_order_item_milestone", {
  id: text("id").primaryKey(),
  orderItemId: text("order_item_id").notNull().references(() => orderItemFulfillment.orderItemId),
  status: text("status").notNull(),
  nextUpdateAt: timestamp("next_update_at", { withTimezone: true }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("customer_order_item_milestone_item_time_idx").on(t.orderItemId, t.occurredAt, t.id),
  check("customer_order_item_milestone_status_valid", sql`${t.status} in ('ORDER_RECEIVED', 'CONTENT_REVIEW', 'PREPARING', 'IN_PROGRESS', 'LINK_VERIFICATION', 'COMPLETE', 'RESOLVED')`),
]).enableRLS();

// Supplier identity is split from queue metadata so unassigned queue reads cannot expose it.
export const orderItemFulfillmentSupplier = pgTable("order_item_fulfillment_supplier", {
  orderItemId: text("order_item_id").primaryKey().references(() => orderItemFulfillment.orderItemId),
  supplierId: text("supplier_id").references(() => supplier.id),
}).enableRLS();

// Publication evidence is append-only. The URL is recorded, never fetched by GPHKM.
export const publicationEvidence = pgTable("publication_evidence", {
  id: text("id").primaryKey(),
  orderItemId: text("order_item_id").notNull().references(() => orderItemFulfillment.orderItemId),
  liveUrl: text("live_url").notNull(),
  method: text("method").notNull().default("STAFF_MANUAL"),
  verifiedByUserId: text("verified_by_user_id").notNull().references(() => user.id),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("publication_evidence_item_verified_idx").on(t.orderItemId, t.verifiedAt),
  check("publication_evidence_method_valid", sql`${t.method} = 'STAFF_MANUAL'`),
]).enableRLS();

export const orderItemWriting = pgTable("order_item_writing", {
  orderItemId: text("order_item_id").primaryKey().references(() => customerOrderItem.id),
  state: text("state").notNull().default("WAITING_FOR_FIRST_DRAFT"),
  firstDraftText: text("first_draft_text"),
  firstDraftSubmittedAt: timestamp("first_draft_submitted_at", { withTimezone: true }),
  revisionRequestText: text("revision_request_text"),
  revisionRequestedAt: timestamp("revision_requested_at", { withTimezone: true }),
  finalDraftText: text("final_draft_text"),
  finalDraftSubmittedAt: timestamp("final_draft_submitted_at", { withTimezone: true }),
  approvedArticleText: text("approved_article_text"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  customerDeclinedAt: timestamp("customer_declined_at", { withTimezone: true }),
  writingRefundMinor: numeric("writing_refund_minor", { precision: 20, scale: 0 }).notNull().default("0"),
  writingRefundLedgerEntryId: text("writing_refund_ledger_entry_id").references(() => walletLedgerEntry.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("order_item_writing_state_updated_idx").on(t.state, t.updatedAt),
  check("order_item_writing_state_valid", sql`${t.state} in ('WAITING_FOR_FIRST_DRAFT', 'FIRST_DRAFT_READY', 'REVISION_REQUESTED', 'FINAL_DRAFT_READY', 'APPROVED_FIRST', 'APPROVED_FINAL', 'CUSTOMER_DECLINED_FINAL')`),
  check("order_item_writing_decline_refund_shape", sql`(${t.state} = 'CUSTOMER_DECLINED_FINAL' and ${t.customerDeclinedAt} is not null and ((${t.writingRefundMinor} = 0 and ${t.writingRefundLedgerEntryId} is null) or (${t.writingRefundMinor} > 0 and ${t.writingRefundLedgerEntryId} is not null))) or (${t.state} <> 'CUSTOMER_DECLINED_FINAL' and ${t.customerDeclinedAt} is null and ${t.writingRefundMinor} = 0 and ${t.writingRefundLedgerEntryId} is null)`),
  check("order_item_writing_text_bounds", sql`(
    (${t.firstDraftText} is null and ${t.firstDraftSubmittedAt} is null or ${t.firstDraftText} is not null and length(btrim(${t.firstDraftText})) between 1 and 20000 and ${t.firstDraftSubmittedAt} is not null)
    and (${t.revisionRequestText} is null and ${t.revisionRequestedAt} is null or ${t.revisionRequestText} is not null and length(btrim(${t.revisionRequestText})) between 1 and 2000 and ${t.revisionRequestedAt} is not null)
    and (${t.finalDraftText} is null and ${t.finalDraftSubmittedAt} is null or ${t.finalDraftText} is not null and length(btrim(${t.finalDraftText})) between 1 and 20000 and ${t.finalDraftSubmittedAt} is not null)
    and (${t.approvedArticleText} is null and ${t.approvedAt} is null or ${t.approvedArticleText} is not null and length(btrim(${t.approvedArticleText})) between 1 and 20000 and ${t.approvedAt} is not null)
  )`),
  check("order_item_writing_stage_consistency", sql`(
    (${t.state} = 'WAITING_FOR_FIRST_DRAFT' and ${t.firstDraftText} is null and ${t.revisionRequestText} is null and ${t.finalDraftText} is null and ${t.approvedArticleText} is null)
    or (${t.state} = 'FIRST_DRAFT_READY' and ${t.firstDraftText} is not null and ${t.revisionRequestText} is null and ${t.finalDraftText} is null and ${t.approvedArticleText} is null)
    or (${t.state} = 'REVISION_REQUESTED' and ${t.firstDraftText} is not null and ${t.revisionRequestText} is not null and ${t.finalDraftText} is null and ${t.approvedArticleText} is null)
    or (${t.state} = 'FINAL_DRAFT_READY' and ${t.firstDraftText} is not null and ${t.revisionRequestText} is not null and ${t.finalDraftText} is not null and ${t.approvedArticleText} is null)
    or (${t.state} = 'CUSTOMER_DECLINED_FINAL' and ${t.firstDraftText} is not null and ${t.revisionRequestText} is not null and ${t.finalDraftText} is not null and ${t.approvedArticleText} is null)
    or (${t.state} = 'APPROVED_FIRST' and ${t.firstDraftText} is not null and ${t.revisionRequestText} is null and ${t.finalDraftText} is null and ${t.approvedArticleText} = ${t.firstDraftText})
    or (${t.state} = 'APPROVED_FINAL' and ${t.firstDraftText} is not null and ${t.revisionRequestText} is not null and ${t.finalDraftText} is not null and ${t.approvedArticleText} = ${t.finalDraftText})
  )`),
]).enableRLS();
