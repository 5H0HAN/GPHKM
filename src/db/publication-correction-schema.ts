import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { user } from "./schema";
import { orderItemFulfillment, publicationEvidence } from "./order-schema";

export const publicationCorrectionCase = pgTable("publication_correction_case", {
  id: text("id").primaryKey(),
  orderItemId: text("order_item_id").notNull().references(() => orderItemFulfillment.orderItemId),
  originalEvidenceId: text("original_evidence_id").notNull().references(() => publicationEvidence.id),
  openedByUserId: text("opened_by_user_id").notNull().references(() => user.id),
  reason: text("reason").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("publication_correction_original_evidence_uq").on(t.originalEvidenceId),
  unique("publication_correction_item_actor_idem_uq").on(t.orderItemId, t.openedByUserId, t.idempotencyKey),
  index("publication_correction_item_created_idx").on(t.orderItemId, t.createdAt),
  check("publication_correction_reason_valid", sql`length(btrim(${t.reason})) between 5 and 2000`),
  check("publication_correction_idempotency_valid", sql`length(${t.idempotencyKey}) between 16 and 128 and ${t.requestHash} ~ '^[0-9a-f]{64}$'`),
]).enableRLS();

export const publicationCorrectionEvent = pgTable("publication_correction_event", {
  id: text("id").primaryKey(),
  correctionCaseId: text("correction_case_id").notNull().references(() => publicationCorrectionCase.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  eventType: text("event_type").notNull(),
  publicationEvidenceId: text("publication_evidence_id").references(() => publicationEvidence.id),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("publication_correction_case_event_type_uq").on(t.correctionCaseId, t.eventType),
  index("publication_correction_event_case_created_idx").on(t.correctionCaseId, t.createdAt),
  check("publication_correction_event_type_valid", sql`(${t.eventType} = 'OPENED' and ${t.publicationEvidenceId} is null) or (${t.eventType} = 'REVERIFIED' and ${t.publicationEvidenceId} is not null)`),
  check("publication_correction_event_reason_valid", sql`length(btrim(${t.reason})) between 1 and 2000`),
]).enableRLS();
