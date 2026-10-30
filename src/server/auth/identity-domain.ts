import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { staffAccount } from "@/db/schema";

export async function isStaffIdentity(userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    const [staff] = await tx.select({ userId: staffAccount.userId })
      .from(staffAccount).where(eq(staffAccount.userId, userId)).limit(1);
    return Boolean(staff);
  });
}
