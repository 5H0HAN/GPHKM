import "server-only";
import { eq, sql } from "drizzle-orm";
import { accessPolicy } from "@/db/schema";
import { db } from "@/db";
import { parseAccessPolicyUpdate } from "@/modules/wallet/access-policy";
import { requireStaffAccess } from "@/server/auth/staff";

export async function getAccessPolicy(headers: Headers) {
  const actor = await requireStaffAccess(headers, "access-policy.manage");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const [row] = await tx.select().from(accessPolicy).where(eq(accessPolicy.id, 1)).limit(1);
    if (!row) throw new Error("Access policy unavailable");
    return row;
  });
}

export async function updateAccessPolicy(headers: Headers, input: {
  minimumUsd: string;
  duration: string;
  expectedVersion: number;
  reason: string;
}) {
  const actor = await requireStaffAccess(headers, "access-policy.manage");
  const update = parseAccessPolicyUpdate(input);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error("Invalid access policy version");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const { rows } = await tx.execute(sql`
      select * from public.gphkm_update_access_policy(
        ${update.minimumMinor}::numeric, ${update.duration}, ${input.expectedVersion}, ${update.reason}
      )
    `);
    const row = rows[0] as { minimum_minor: string; duration: string; version: number; changed: boolean } | undefined;
    if (!row) throw new Error("Access policy update failed");
    return { minimumMinor: row.minimum_minor, duration: row.duration, version: row.version, changed: row.changed };
  });
}
