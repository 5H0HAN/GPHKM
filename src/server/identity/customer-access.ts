import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export async function isCustomerAccountSuspended(userId: string): Promise<boolean> {
  if (!userId || userId.length > 128) return true;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    const result = await tx.execute(sql`select public.gphkm_customer_account_is_suspended(${userId}) as suspended`);
    return (result as unknown as { rows?: Array<{ suspended: boolean }> }).rows?.[0]?.suspended === true;
  });
}
