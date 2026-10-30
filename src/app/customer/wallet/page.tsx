import Link from "next/link";
import { headers } from "next/headers";
import { getRechargeHistory, getWalletSummary } from "@/server/wallet/read";
import { loadCustomerWorkspace, selectedOrganizationId } from "../workspace";
import styles from "../customer.module.css";

export const dynamic = "force-dynamic";

function money(minor: string) {
  const amount = BigInt(minor);
  const dollars = amount / 100n;
  const cents = (amount % 100n).toString().padStart(2, "0");
  return `$${dollars.toLocaleString("en-US")}.${cents}`;
}

export default async function WalletPage({ searchParams }: { searchParams: Promise<{ organizationId?: string | string[]; historyPage?: string | string[] }> }) {
  const workspace = await loadCustomerWorkspace();
  if (!workspace.authenticated) return null;
  const params = await searchParams;
  const organizationId = selectedOrganizationId(workspace.organizations, Array.isArray(params.organizationId) ? params.organizationId[0] : params.organizationId);
  if (!organizationId) return <div className={styles.error}>Your organization wallet is not available yet.</div>;
  const historyPage = Array.isArray(params.historyPage) ? params.historyPage[0] : params.historyPage;
  const isOwner = workspace.organizations.find((org) => org.id === organizationId)?.role === "OWNER";

  let summary: Awaited<ReturnType<typeof getWalletSummary>> | null = null;
  let history: Awaited<ReturnType<typeof getRechargeHistory>> | null = null;
  try {
    summary = await getWalletSummary(await headers(), organizationId);
    if (isOwner) {
      history = await getRechargeHistory(await headers(), organizationId, historyPage);
    }
  } catch {
    return <div className={styles.error}>Wallet information could not be loaded. Refresh or contact support if this continues.</div>;
  }

  return (
    <>
      <div className={styles.headingRow}>
        <div>
          <h1 className={styles.title}>Wallet</h1>
          <p className={styles.subtitle}>Wallet funds are shared by your organization. Only Owners can view recharge history.</p>
        </div>
      </div>
      {summary?.spendingRestricted && <section className={styles.error} role="status">
        Wallet activity is under payment review. New wallet top-ups and orders are temporarily unavailable for this organization while the review is unresolved. Your balance remains recorded; contact Support if you need help.
      </section>}
      <section className={styles.grid}>
        <article className={`${styles.panel} ${styles.span5}`}>
          <h2 className={styles.panelTitle}>Available balance</h2>
          <div className={styles.metric}>{money(summary?.availableMinor ?? "0")}</div>
          <div className={styles.metricLabel}>USD available to place orders</div>
          {!summary?.spendingRestricted && <Link className={styles.panelAction} href={`/customer/wallet/recharge?organizationId=${encodeURIComponent(organizationId)}`}>Load balance</Link>}
        </article>
        <article className={`${styles.panel} ${styles.span7}`}>
          <h2 className={styles.panelTitle}>Balance use</h2>
          <p className={styles.panelText}>Orders use your wallet balance at checkout. Unused wallet funds do not expire. Voluntary cash-out is not available.</p>
        </article>
        <article className={`${styles.panel} ${styles.span12}`}>
          <h2 className={styles.panelTitle}>Recharge history</h2>
          {!isOwner ? (
            <p className={styles.panelText}>Recharge history is available to organization Owners.</p>
          ) : !history?.entries.length ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>No recharges yet</p>
              <p className={styles.panelText}>Wallet top-up attempts will appear here.</p>
            </div>
          ) : (
            <>
              <ul className={styles.list}>
                {history.entries.map((entry) => (
                  <li className={styles.listItem} key={entry.id}>
                    <span>{new Date(entry.createdAt).toLocaleDateString("en-US", { dateStyle: "medium" })}</span>
                    <span>{money(String(entry.amountMinor))}</span>
                    <span>{entry.status}</span>
                  </li>
                ))}
              </ul>
              {history.pagination.totalPages > 1 && <nav className={styles.pagination} aria-label="Recharge history pages">
                {history.pagination.page > 1 ? <Link href={`/customer/wallet?organizationId=${encodeURIComponent(organizationId)}&historyPage=${history.pagination.page - 1}`}>Previous</Link> : <span />}
                <span>Page {history.pagination.page} of {history.pagination.totalPages} · {history.pagination.total} recharges</span>
                {history.pagination.page < history.pagination.totalPages ? <Link href={`/customer/wallet?organizationId=${encodeURIComponent(organizationId)}&historyPage=${history.pagination.page + 1}`}>Next</Link> : <span />}
              </nav>}
            </>
          )}
        </article>
      </section>
    </>
  );
}
