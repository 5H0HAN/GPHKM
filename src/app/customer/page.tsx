import Link from "next/link";
import { headers } from "next/headers";
import { getMarketplaceAccess, getWalletSummary } from "@/server/wallet/read";
import { getMyOrders } from "@/server/orders/checkout";
import { loadCustomerWorkspace } from "./workspace";
import styles from "./customer.module.css";
import { firstQueryValue } from "@/modules/query-params";

export const dynamic = "force-dynamic";

function money(minor: string) {
  const amount = BigInt(minor);
  const dollars = amount / 100n;
  const cents = (amount % 100n).toString().padStart(2, "0");
  return `$${dollars.toLocaleString("en-US")}.${cents}`;
}

function label(value: string) {
  return value.toLowerCase().split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function date(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function CustomerHome({ searchParams }: { searchParams: Promise<{ organizationId?: string | string[] }> }) {
  const workspace = await loadCustomerWorkspace();
  const requestHeaders = await headers();
  const params = await searchParams;
  const requestedId = firstQueryValue(params.organizationId);
  const organization = workspace.organizations.find(({ id }) => id === requestedId) ?? workspace.organizations[0];
  if (workspace.authenticated && !workspace.organizations.length) {
    return null; // The customer layout owns legal acceptance and organization onboarding.
  }
  let balance: string | null = null;
  let orders: Awaited<ReturnType<typeof getMyOrders>> | null = null;
  let access: Awaited<ReturnType<typeof getMarketplaceAccess>> | null = null;
  let orderLoadFailed = false;
  if (organization) {
    const [walletResult, ordersResult, accessResult] = await Promise.allSettled([
      getWalletSummary(requestHeaders, organization.id),
      getMyOrders(requestHeaders, organization.id),
      getMarketplaceAccess(requestHeaders, organization.id),
    ]);
    if (walletResult.status === "fulfilled") balance = walletResult.value.balanceMinor;
    if (ordersResult.status === "fulfilled") orders = ordersResult.value;
    else orderLoadFailed = true;
    if (accessResult.status === "fulfilled") access = accessResult.value;
  }
  const orderCount = orders?.length ?? 0;
  const itemCount = orders?.reduce((total, order) => total + order.items.length, 0) ?? 0;
  const pendingItemCount = orders?.reduce((total, order) => total + order.items.filter((item) => !["COMPLETE", "RESOLVED", "CANCELLED", "REFUNDED"].includes(item.status)).length, 0) ?? 0;
  const recentItems = orders?.flatMap((order) => order.items.map((item) => ({
    orderId: order.id,
    orderDate: order.createdAt,
    title: typeof item.listing.title === "string" ? item.listing.title : "Website placement",
    status: item.status,
    updatedAt: item.lastUpdatedAt ?? order.createdAt,
    nextUpdateAt: item.nextUpdateAt,
  }))).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 4) ?? [];

  return (
    <>
      <div className={styles.headingRow}>
        <div>
          <h1 className={styles.title}>Good to see you</h1>
          <p className={styles.subtitle}>A clear view of your placement work, account balance, and next steps.</p>
        </div>
      </div>
      {!organization && <div className={styles.banner}><strong>Your organization is being set up.</strong> Once it is ready, your wallet and marketplace will appear here.</div>}
      <section className={styles.grid} aria-label="Workspace summary">
        <article className={`${styles.panel} ${styles.span4}`}>
          <h2 className={styles.panelTitle}>Organization wallet</h2>
          <p className={styles.panelText}>Available funds for new placements.</p>
          <div className={styles.metric}>{balance === null ? "—" : money(balance)}</div>
          <div className={styles.metricLabel}>{balance === null ? "Wallet details are loading" : "USD balance"}</div>
          <Link className={styles.panelAction} href={organization ? `/customer/wallet?organizationId=${encodeURIComponent(organization.id)}` : "/customer/wallet"}>View wallet</Link>
        </article>
        <article className={`${styles.panel} ${styles.span4}`}>
          <h2 className={styles.panelTitle}>Your orders</h2>
          <p className={styles.panelText}>Follow each placement through review and publication.</p>
          <div className={styles.metric}>{orderLoadFailed ? "—" : orderCount}</div>
          <div className={styles.metricLabel}>{orderLoadFailed ? "Order details could not be loaded" : `${itemCount} placement${itemCount === 1 ? "" : "s"} · ${pendingItemCount} in progress`}</div>
          <Link className={styles.panelAction} href={organization ? `/customer/orders?organizationId=${encodeURIComponent(organization.id)}` : "/customer/orders"}>View orders</Link>
        </article>
        <article className={`${styles.panel} ${styles.span4}`}>
          <h2 className={styles.panelTitle}>Marketplace</h2>
          <p className={styles.panelText}>Explore reviewed websites and their placement requirements.</p>
          <div className={styles.empty}>
            <p className={styles.panelText}>Listings will appear after the catalog is ready.</p>
            <Link className={styles.panelAction} href={`/customer/catalog?organizationId=${encodeURIComponent(organization.id)}`}>Browse marketplace</Link>
          </div>
        </article>
        <article className={`${styles.panel} ${styles.span7}`}>
          <h2 className={styles.panelTitle}>Recent activity</h2>
          {orderLoadFailed ? <div className={styles.empty}>
            <p className={styles.emptyTitle}>Activity could not be loaded</p>
            <p className={styles.panelText}>Refresh the page or open your orders to try again.</p>
            <Link className={styles.panelAction} href={`/customer/orders?organizationId=${encodeURIComponent(organization.id)}`}>Open orders</Link>
          </div> : recentItems.length ? <ul className={styles.list}>
            {recentItems.map((item, index) => <li className={styles.listItem} key={`${item.orderId}-${index}`}>
              <span><strong>{item.title}</strong><br />{label(item.status)} · Order {item.orderId.slice(0, 8)}</span>
              <span><time dateTime={item.updatedAt}>{date(item.updatedAt)}</time>{item.nextUpdateAt && <><br />Next update {date(item.nextUpdateAt)}</>}</span>
            </li>)}
          </ul> : <div className={styles.empty}>
            <p className={styles.emptyTitle}>No placement activity yet</p>
            <p className={styles.panelText}>Your order updates will appear here.</p>
          </div>}
          {!orderLoadFailed && orderCount > 0 && organization && <Link className={styles.panelAction} href={`/customer/orders?organizationId=${encodeURIComponent(organization.id)}`}>View all orders</Link>}
        </article>
        <article className={`${styles.panel} ${styles.span5}`}>
          <h2 className={styles.panelTitle}>Account</h2>
          <p className={styles.panelText}>{workspace.customer?.email}</p>
          <ul className={styles.list}>
            <li className={styles.listItem}><span>Organization</span><span>{organization?.name ?? "Pending"}</span></li>
            <li className={styles.listItem}><span>Marketplace access</span><span>{!organization ? "Not available yet" : access?.paidAccessActive ? "Paid access active" : access?.trialActive ? "Trial active" : access ? "Recharge required" : "Status unavailable"}</span></li>
          </ul>
          <Link className={styles.panelAction} href="/customer/settings">Manage settings</Link>
        </article>
      </section>
    </>
  );
}
