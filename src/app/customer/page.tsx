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
          <p className={styles.pageKicker}>Workspace overview</p>
          <h1 className={styles.title}>Good to see you{organization?.name ? `, ${organization.name}` : ""}</h1>
          <p className={styles.subtitle}>Your team’s placement work, account balance, and next steps in one place.</p>
        </div>
        <Link className={styles.primaryAction} href={organization ? `/customer/catalog?organizationId=${encodeURIComponent(organization.id)}` : "/customer/catalog"}>Browse marketplace <span aria-hidden="true">↗</span></Link>
      </div>
      {!organization && <div className={styles.banner}><strong>Your organization is being set up.</strong> Once it is ready, your wallet and marketplace will appear here.</div>}
      <section className={styles.dashboardHome} aria-label="Workspace overview">
        <div className={styles.summaryStrip}>
          <article className={styles.summaryCard}>
            <div className={styles.summaryTop}><span>Organization balance</span><span className={styles.summaryMark} aria-hidden="true">$</span></div>
            <strong className={styles.summaryValue}>{balance === null ? "—" : money(balance)}</strong>
            <div className={styles.summaryBottom}><span>{balance === null ? "Wallet unavailable" : "USD available"}</span><Link href={organization ? `/customer/wallet?organizationId=${encodeURIComponent(organization.id)}` : "/customer/wallet"}>Open wallet <span aria-hidden="true">↗</span></Link></div>
          </article>
          <article className={styles.summaryCard}>
            <div className={styles.summaryTop}><span>Orders</span><span className={styles.summaryMark} aria-hidden="true">↗</span></div>
            <strong className={styles.summaryValue}>{orderLoadFailed ? "—" : orderCount}</strong>
            <div className={styles.summaryBottom}><span>{orderLoadFailed ? "Order details unavailable" : `${itemCount} placement${itemCount === 1 ? "" : "s"} · ${pendingItemCount} active`}</span><Link href={organization ? `/customer/orders?organizationId=${encodeURIComponent(organization.id)}` : "/customer/orders"}>View orders <span aria-hidden="true">↗</span></Link></div>
          </article>
          <article className={styles.summaryCard}>
            <div className={styles.summaryTop}><span>Marketplace access</span><span className={styles.summaryMark} aria-hidden="true">◇</span></div>
            <strong className={styles.accessValue}>{!organization ? "Setting up" : access?.paidAccessActive ? "Active" : access?.trialActive ? "Trial access" : access ? "Recharge needed" : "Unavailable"}</strong>
            <div className={styles.summaryBottom}><span>Browse reviewed placement options</span><Link href={organization ? `/customer/catalog?organizationId=${encodeURIComponent(organization.id)}` : "/customer/catalog"}>Explore <span aria-hidden="true">↗</span></Link></div>
          </article>
        </div>

        <div className={styles.homeColumns}>
          <section className={styles.homePanel} aria-labelledby="activity-heading">
            <div className={styles.homePanelHeader}><div><p className={styles.pageKicker}>Your workspace</p><h2 id="activity-heading">Recent placement activity</h2></div>{orderCount > 0 && organization && <Link href={`/customer/orders?organizationId=${encodeURIComponent(organization.id)}`}>All orders <span aria-hidden="true">↗</span></Link>}</div>
          {orderLoadFailed ? <div className={styles.empty}>
            <p className={styles.emptyTitle}>Activity could not be loaded</p>
            <p className={styles.panelText}>Refresh the page or open your orders to try again.</p>
            <Link className={styles.panelAction} href={organization ? `/customer/orders?organizationId=${encodeURIComponent(organization.id)}` : "/customer/orders"}>Open orders</Link>
          </div> : recentItems.length ? <ul className={styles.list}>
            {recentItems.map((item, index) => <li className={styles.listItem} key={`${item.orderId}-${index}`}>
              <span className={styles.activityTitle}><span className={styles.activityDot} aria-hidden="true" /><span><strong>{item.title}</strong><small>{label(item.status)} · Order {item.orderId.slice(0, 8)}</small></span></span>
              <span className={styles.activityDate}><time dateTime={item.updatedAt}>{date(item.updatedAt)}</time>{item.nextUpdateAt && <small>Next update {date(item.nextUpdateAt)}</small>}</span>
            </li>)}
          </ul> : <div className={styles.empty}>
            <span className={styles.emptyMark} aria-hidden="true">↗</span>
            <p className={styles.emptyTitle}>Your next placement starts here</p>
            <p className={styles.panelText}>Browse the marketplace to compare requirements and find the right site for your team.</p>
            <Link className={styles.panelAction} href={organization ? `/customer/catalog?organizationId=${encodeURIComponent(organization.id)}` : "/customer/catalog"}>Explore marketplace</Link>
          </div>}
          </section>
          <aside className={styles.homeSide} aria-label="Account details">
            <section className={styles.homePanel}>
              <div className={styles.homePanelHeader}><div><p className={styles.pageKicker}>Workspace</p><h2>Account details</h2></div><span className={styles.accountIcon} aria-hidden="true">{organization?.name?.slice(0, 1).toUpperCase() ?? "G"}</span></div>
              <dl className={styles.accountDetails}>
                <div><dt>Organization</dt><dd>{organization?.name ?? "Setting up"}</dd></div>
                <div><dt>Signed in as</dt><dd>{workspace.customer?.email ?? "Customer account"}</dd></div>
                <div><dt>Placement activity</dt><dd>{orderLoadFailed ? "Unavailable" : `${orderCount} order${orderCount === 1 ? "" : "s"}`}</dd></div>
              </dl>
              <Link className={styles.secondaryAction} href="/customer/settings">Manage account settings <span aria-hidden="true">↗</span></Link>
            </section>
            <section className={styles.tipPanel}>
              <span className={styles.tipMark} aria-hidden="true">i</span>
              <div><h2>Clear progress, all the way through</h2><p>Every order shows its latest milestone and the next update date, so your team knows what to expect.</p><Link href={organization ? `/customer/orders?organizationId=${encodeURIComponent(organization.id)}` : "/customer/orders"}>How orders progress <span aria-hidden="true">↗</span></Link></div>
            </section>
          </aside>
        </div>
      </section>
    </>
  );
}
