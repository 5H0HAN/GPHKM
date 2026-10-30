import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { user } from "./schema";

// Acceptance is evidence: no update/delete or mutable marketing preference here.
export const customerLegalAcceptance = pgTable("customer_legal_acceptance", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  termsVersion: text("terms_version").notNull(),
  privacyVersion: text("privacy_version").notNull(),
  termsUrl: text("terms_url").notNull(),
  privacyUrl: text("privacy_url").notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("customer_legal_acceptance_user_versions_uq").on(t.userId, t.termsVersion, t.privacyVersion),
  index("customer_legal_acceptance_user_time_idx").on(t.userId, t.acceptedAt),
  check("customer_legal_acceptance_self_actor", sql`${t.userId} = ${t.actorUserId}`),
  check("customer_legal_acceptance_versions_valid", sql`${t.termsVersion} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$' and ${t.privacyVersion} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'`),
  check("customer_legal_acceptance_urls_bounded", sql`length(${t.termsUrl}) between 8 and 2048 and length(${t.privacyUrl}) between 8 and 2048`),
]).enableRLS();
