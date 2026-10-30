import "server-only";
import { count, desc, eq, sql } from "drizzle-orm";
import { organization, paymentAttempt, walletAccount } from "@/db/schema";
import { withOrganizationContext } from "@/server/identity/customer-context";
import { isMarketplaceTrialActive, marketplaceTrialEndsAt } from "@/modules/wallet/marketplace-trial";

export async function getWalletSummary(headers: Headers, organizationId: string, requiredMinor?: bigint) {
  return withOrganizationContext(headers, organizationId, async (tx) => {
    const [account] = await tx.select({ balanceMinor: walletAccount.balanceMinor })
      .from(walletAccount).where(eq(walletAccount.organizationId, organizationId)).limit(1);
    const { rows: holdRows } = await tx.execute(sql`select public.gphkm_customer_wallet_held_total(${organizationId}) as amount_minor`);
    const { rows: restrictionRows } = await tx.execute(sql`select public.gphkm_org_wallet_spending_restricted(${organizationId}) as restricted`);
    const spendingRestricted = (restrictionRows[0] as { restricted: boolean } | undefined)?.restricted === true;
    const balanceMinor = BigInt(account?.balanceMinor ?? "0");
    const heldMinor = BigInt((holdRows[0] as { amount_minor: string } | undefined)?.amount_minor ?? "0");
    return {
      currency: "USD" as const,
      balanceMinor: balanceMinor.toString(),
      availableMinor: spendingRestricted ? "0" : (balanceMinor > heldMinor ? balanceMinor - heldMinor : 0n).toString(),
      spendingRestricted,
      sufficient: requiredMinor === undefined ? undefined : !spendingRestricted && requiredMinor >= 0n && balanceMinor - heldMinor >= requiredMinor,
    };
  });
}

export async function getRechargeHistory(headers: Headers, organizationId: string, requestedPage: unknown = 1) {
  return withOrganizationContext(headers, organizationId, async (tx, role) => {
    if (role !== "OWNER") throw new Error("Forbidden");
    const pageSize = 50;
    const parsedPage = typeof requestedPage === "string" && /^[1-9]\d{0,5}$/.test(requestedPage)
      ? Number(requestedPage) : typeof requestedPage === "number" ? requestedPage : 1;
    const [countRow] = await tx.select({ total: count() }).from(paymentAttempt)
      .where(eq(paymentAttempt.organizationId, organizationId));
    const total = countRow?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? Math.min(parsedPage, totalPages) : 1;
    const entries = await tx.select({
      id: paymentAttempt.id,
      amountMinor: paymentAttempt.amountMinor,
      currency: paymentAttempt.currency,
      status: paymentAttempt.state,
      createdAt: paymentAttempt.createdAt,
      settledAt: paymentAttempt.settledAt,
    }).from(paymentAttempt)
      .where(eq(paymentAttempt.organizationId, organizationId))
      .orderBy(desc(paymentAttempt.createdAt), desc(paymentAttempt.id))
      .limit(pageSize).offset((page - 1) * pageSize);
    return { entries, pagination: { page, totalPages, total, pageSize } };
  });
}

export async function getMarketplaceAccess(headers: Headers, organizationId: string, now = new Date()) {
  return withOrganizationContext(headers, organizationId, async (tx) => {
    const [org] = await tx.select({ createdAt: organization.createdAt })
      .from(organization).where(eq(organization.id, organizationId)).limit(1);
    if (!org) throw new Error("Organization unavailable");
    const trialEndsAt = marketplaceTrialEndsAt(org.createdAt);
    const trialActive = isMarketplaceTrialActive(org.createdAt, now);
    const { rows } = await tx.execute(sql`select public.gphkm_customer_has_marketplace_access(${organizationId}) as active`);
    const paidAccessActive = (rows[0] as { active: boolean } | undefined)?.active === true;
    return {
      allowed: trialActive || paidAccessActive,
      paidAccessActive,
      trialEndsAt,
      trialActive,
    };
  });
}

export async function requireMarketplaceAccess(headers: Headers, organizationId: string, now = new Date()) {
  const access = await getMarketplaceAccess(headers, organizationId, now);
  if (!access.allowed) throw new Error("Marketplace access required");
  return access;
}
