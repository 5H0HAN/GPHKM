import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organization, user } from "./schema";
import { customerOrder, customerOrderItem } from "./order-schema";

export const supportCase = pgTable("support_case", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  orderId: text("order_id").notNull().references(() => customerOrder.id),
  orderItemId: text("order_item_id").notNull().references(() => customerOrderItem.id),
  openedByUserId: text("opened_by_user_id").notNull().references(() => user.id),
  summary: text("summary").notNull(),
  state: text("state").notNull().default("OPEN"),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("support_case_open_idem_uq").on(t.organizationId, t.openedByUserId, t.idempotencyKey),
  index("support_case_org_updated_idx").on(t.organizationId, t.updatedAt, t.id),
  index("support_case_updated_cursor_idx").on(t.updatedAt, t.id),
  index("support_case_item_idx").on(t.orderItemId),
  check("support_case_state_valid", sql`${t.state} in ('OPEN','INVESTIGATING','WAITING_ON_CUSTOMER','WAITING_ON_SUPPLIER','FINANCE_REVIEW','RESOLVED','CLOSED')`),
  check("support_case_summary_valid", sql`length(trim(${t.summary})) between 1 and 2000`),
  check("support_case_request_valid", sql`length(${t.idempotencyKey}) between 16 and 128 and ${t.requestHash} ~ '^[0-9a-f]{64}$'`),
]).enableRLS();

// Visibility is enforced by RLS as well as explicit server projections. Internal
// notes and financial deliberations never share customer-visible history rows.
export const supportCaseEvent = pgTable("support_case_event", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull().references(() => supportCase.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  actorKind: text("actor_kind").notNull(),
  kind: text("kind").notNull(),
  audience: text("audience").notNull(),
  body: text("body").notNull(),
  fromState: text("from_state"),
  toState: text("to_state"),
  decision: text("decision"),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("support_case_event_idem_uq").on(t.caseId, t.actorUserId, t.idempotencyKey),
  index("support_case_event_history_idx").on(t.caseId, t.createdAt, t.id),
  check("support_case_event_body_valid", sql`length(trim(${t.body})) between 1 and 4000`),
  check("support_case_event_actor_valid", sql`${t.actorKind} in ('CUSTOMER','STAFF')`),
  check("support_case_event_kind_valid", sql`${t.kind} in ('OPENED','REPLY','NOTE','STATE_CHANGED','FINANCE_DECISION')`),
  check("support_case_event_audience_valid", sql`${t.audience} in ('CUSTOMER','INTERNAL','FINANCE')`),
  check("support_case_event_decision_valid", sql`${t.decision} is null or ${t.decision} in ('APPROVED','DENIED','MORE_INFORMATION_REQUIRED')`),
  check("support_case_event_shape", sql`(${t.kind} = 'OPENED' and ${t.audience} = 'INTERNAL' and ${t.actorKind} = 'CUSTOMER' and ${t.fromState} is null and ${t.toState} = 'OPEN' and ${t.decision} is null)
    or (${t.kind} = 'REPLY' and ${t.audience} = 'CUSTOMER' and ${t.fromState} is null and ${t.toState} is null and ${t.decision} is null)
    or (${t.kind} = 'NOTE' and ${t.audience} in ('INTERNAL','FINANCE') and ${t.actorKind} = 'STAFF' and ${t.fromState} is null and ${t.toState} is null and ${t.decision} is null)
    or (${t.kind} = 'STATE_CHANGED' and ${t.audience} in ('INTERNAL','FINANCE') and ${t.actorKind} = 'STAFF' and ${t.fromState} is not null and ${t.toState} is not null and ${t.decision} is null)
    or (${t.kind} = 'FINANCE_DECISION' and ${t.audience} = 'FINANCE' and ${t.actorKind} = 'STAFF' and ${t.fromState} is null and ${t.toState} is null and ${t.decision} is not null)`),
  check("support_case_event_request_valid", sql`length(${t.idempotencyKey}) between 16 and 128 and ${t.requestHash} ~ '^[0-9a-f]{64}$'`),
]).enableRLS();
