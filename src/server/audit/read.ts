import "server-only";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditEvent, user } from "@/db/schema";
import { requireStaffAccess } from "@/server/auth/staff";

function parseCursor(value: string | undefined) {
  if (!value || value.length > 256 || !/^[A-Za-z0-9_-]{16,256}$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.indexOf("\n");
    if (separator < 0) return null;
    const timestamp = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    const createdAt = new Date(timestamp);
    if (createdAt.toISOString() !== timestamp || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { createdAt, id };
  } catch { return null; }
}

export async function listStaffAuditEvents(headers: Headers, before?: string) {
  const actor = await requireStaffAccess(headers, "audit.read");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const cursor = parseCursor(before);
    const query = tx.select({
      id: auditEvent.id,
      action: auditEvent.action,
      targetType: auditEvent.targetType,
      targetId: auditEvent.targetId,
      reasonCode: auditEvent.reasonCode,
      correlationId: auditEvent.correlationId,
      result: sql<string | null>`case when (${auditEvent.metadata}->>'result') ~ '^[A-Z][A-Z0-9_]{0,31}$' then ${auditEvent.metadata}->>'result' else null end`,
      createdAt: auditEvent.createdAt,
      actorName: user.name,
    }).from(auditEvent)
      .leftJoin(user, eq(user.id, auditEvent.actorUserId));
    const rows = await (cursor ? query.where(or(
      lt(auditEvent.createdAt, cursor.createdAt),
      and(eq(auditEvent.createdAt, cursor.createdAt), lt(auditEvent.id, cursor.id)),
    )) : query)
      .orderBy(desc(auditEvent.createdAt), desc(auditEvent.id))
      .limit(51);
    const hasMore = rows.length > 50;
    const items = hasMore ? rows.slice(0, 50) : rows;
    const last = items.at(-1);
    const nextCursor = hasMore && last
      ? Buffer.from(`${last.createdAt.toISOString()}\n${last.id}`).toString("base64url")
      : null;
    return { items, nextCursor };
  });
}
