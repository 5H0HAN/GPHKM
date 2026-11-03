import { sql } from "drizzle-orm";
import { check, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./schema";

export const staffAttentionDismissal = pgTable("staff_attention_dismissal", {
  staffUserId: text("staff_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  taskKey: text("task_key").notNull(),
  taskVersion: text("task_version").notNull(),
  doneAt: timestamp("done_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "staff_attention_dismissal_pk", columns: [table.staffUserId, table.taskKey] }),
  check("staff_attention_task_key_valid", sql`length(${table.taskKey}) between 1 and 240`),
  check("staff_attention_task_version_valid", sql`${table.taskVersion} ~ '^[0-9a-f]{64}$'`),
]).enableRLS();
