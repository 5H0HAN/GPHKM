import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, user } from "./schema";

export const organizationClosureRequest = pgTable("organization_closure_request", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  openedByUserId: text("opened_by_user_id").notNull().references(() => user.id),
  summary: text("summary").notNull(),
  state: text("state").notNull().default("OPEN"),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedByUserId: text("closed_by_user_id").references(() => user.id),
}, (t) => [
  unique("organization_closure_request_opener_idem_uq").on(t.organizationId, t.openedByUserId, t.idempotencyKey),
  uniqueIndex("organization_closure_request_one_active_uq").on(t.organizationId).where(sql`${t.state} <> 'CLOSED'`),
  index("organization_closure_request_state_updated_idx").on(t.state, t.updatedAt),
  index("organization_closure_request_updated_page_idx").on(t.updatedAt, t.id),
  check("organization_closure_request_state_valid", sql`${t.state} in ('OPEN','INVESTIGATING','WAITING_ON_CUSTOMER','CLOSED')`),
  check("organization_closure_request_summary_valid", sql`length(trim(${t.summary})) between 5 and 2000`),
  check("organization_closure_request_idem_valid", sql`length(${t.idempotencyKey}) between 16 and 128 and ${t.requestHash} ~ '^[0-9a-f]{64}$'`),
  check("organization_closure_request_closed_shape", sql`(${t.state} = 'CLOSED' and ${t.closedAt} is not null and ${t.closedByUserId} is not null) or (${t.state} <> 'CLOSED' and ${t.closedAt} is null and ${t.closedByUserId} is null)`),
]).enableRLS();

export const organizationClosureEvent = pgTable("organization_closure_event", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().references(() => organizationClosureRequest.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  actorKind: text("actor_kind").notNull(),
  kind: text("kind").notNull(),
  audience: text("audience").notNull(),
  body: text("body").notNull(),
  fromState: text("from_state"),
  toState: text("to_state"),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("organization_closure_event_idem_uq").on(t.requestId, t.actorUserId, t.idempotencyKey),
  index("organization_closure_event_history_idx").on(t.requestId, t.createdAt),
  check("organization_closure_event_actor_valid", sql`${t.actorKind} in ('CUSTOMER','STAFF')`),
  check("organization_closure_event_kind_valid", sql`${t.kind} in ('OPENED','STATE_CHANGED','REPLY','NOTE')`),
  check("organization_closure_event_audience_valid", sql`${t.audience} in ('CUSTOMER','INTERNAL')`),
  check("organization_closure_event_body_valid", sql`length(trim(${t.body})) between 1 and 4000`),
  check("organization_closure_event_idem_valid", sql`length(${t.idempotencyKey}) between 16 and 128 and ${t.requestHash} ~ '^[0-9a-f]{64}$'`),
  check("organization_closure_event_state_shape", sql`(${t.kind} = 'OPENED' and ${t.fromState} is null and ${t.toState} = 'OPEN') or (${t.kind} = 'STATE_CHANGED' and ${t.fromState} is not null and ${t.toState} is not null) or (${t.kind} in ('REPLY','NOTE') and ${t.fromState} is null and ${t.toState} is null)`),
  check("organization_closure_event_opened_shape", sql`${t.kind} <> 'OPENED' or (${t.actorKind} = 'CUSTOMER' and ${t.audience} = 'CUSTOMER')`),
  check("organization_closure_event_reply_shape", sql`${t.kind} <> 'REPLY' or (${t.actorKind} in ('CUSTOMER','STAFF') and ${t.audience} = 'CUSTOMER')`),
  check("organization_closure_event_note_shape", sql`${t.kind} <> 'NOTE' or (${t.actorKind} = 'STAFF' and ${t.audience} = 'INTERNAL')`),
  check("organization_closure_event_state_shape_actor", sql`${t.kind} <> 'STATE_CHANGED' or (${t.actorKind} = 'STAFF' and ${t.audience} in ('CUSTOMER','INTERNAL'))`),
]).enableRLS();
