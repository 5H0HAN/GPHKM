import "server-only";
import type { DbTransaction } from "@/server/audit/append";
import { walletAccount } from "@/db/schema";

export async function ensureWalletAccount(tx: DbTransaction, organizationId: string): Promise<void> {
  await tx.insert(walletAccount).values({ organizationId, currency: "USD" })
    .onConflictDoNothing({ target: walletAccount.organizationId });
}
