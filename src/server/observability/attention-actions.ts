"use server";

import { headers } from "next/headers";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { staffAttentionDismissal } from "@/db/operations-schema";
import { getStaffOperationsAlerts } from "@/server/observability/operations-alerts";
import { requireStaffAccess } from "@/server/auth/staff";

export type AttentionActionResult = { ok: true } | { ok: false; message: string };

export async function setOverviewAttentionDone(taskKey: string, taskVersion: string, done: boolean): Promise<AttentionActionResult> {
  if (typeof taskKey !== "string" || taskKey.length < 1 || taskKey.length > 240
    || typeof taskVersion !== "string" || !/^[0-9a-f]{64}$/.test(taskVersion)
    || typeof done !== "boolean") {
    return { ok: false, message: "This overview item is invalid. Refresh and try again." };
  }

  const requestHeaders = await headers();
  let actor: Awaited<ReturnType<typeof requireStaffAccess>>;
  try {
    actor = await requireStaffAccess(requestHeaders, "audit.read");
  } catch {
    return { ok: false, message: "Staff access changed. Reload Overview to continue." };
  }

  let currentItem;
  try {
    const alerts = await getStaffOperationsAlerts(requestHeaders, actor);
    currentItem = alerts.flatMap((alert) => alert.items).find((item) => item.key === taskKey && item.version === taskVersion);
  } catch {
    return { ok: false, message: "Overview could not verify this item. Try again." };
  }
  if (!currentItem) return { ok: false, message: "This item has changed. Refresh Overview before updating it." };

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
      if (done) {
        await tx.insert(staffAttentionDismissal).values({
          staffUserId: actor.userId,
          taskKey,
          taskVersion,
        }).onConflictDoUpdate({
          target: [staffAttentionDismissal.staffUserId, staffAttentionDismissal.taskKey],
          set: { taskVersion, doneAt: new Date() },
        });
      } else {
        await tx.delete(staffAttentionDismissal).where(and(
          eq(staffAttentionDismissal.staffUserId, actor.userId),
          eq(staffAttentionDismissal.taskKey, taskKey),
          eq(staffAttentionDismissal.taskVersion, taskVersion),
        ));
      }
    });
    return { ok: true };
  } catch {
    return { ok: false, message: "Could not update your Overview. Try again." };
  }
}
