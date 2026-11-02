import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { requireStaffAccess } from "@/server/auth/staff";
import { getStaffCustomer } from "@/server/identity/staff-customer-directory";
import { setCustomerAccountStateAction, updateCustomerMembershipAction } from "../actions";
import styles from "../customers.module.css";

export const dynamic = "force-dynamic";

function formatDate(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleDateString();
}

function formatUsdBalance(minorUnits: string) {
  if (!/^(0|[1-9]\d{0,19})$/.test(minorUnits)) return "Balance unavailable";
  const amount = BigInt(minorUnits);
  return `$${(amount / 100n).toLocaleString("en-US")}.${(amount % 100n).toString().padStart(2, "0")}`;
}

const accountReasons = [
  ["CUSTOMER_REQUEST", "Customer request"], ["POLICY_REVIEW", "Policy review"],
  ["SECURITY_REVIEW", "Security review"], ["OTHER_OPERATIONAL", "Other operational reason"],
] as const;
const membershipReasons = [
  ["CUSTOMER_REQUEST", "Customer request"], ["SUPPORT_REVIEW", "Support review"],
  ["SECURITY_REVIEW", "Security review"], ["CORRECTION", "Correction"],
] as const;

export default async function CustomerDetailPage({ params, searchParams }: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<{ updated?: string | string[]; error?: string | string[] }>;
}) {
  const { customerId } = await params;
  const requestHeaders = await headers();
  try { await requireStaffAccess(requestHeaders, "customer.directory.read"); }
  catch { notFound(); }
  const detail = await getStaffCustomer(requestHeaders, customerId);
  if (!detail) notFound();
  const query = await searchParams;
  const updated = Array.isArray(query.updated) ? query.updated[0] : query.updated;
  const error = Array.isArray(query.error) ? query.error[0] : query.error;
  const isSuspended = detail.customer.accountState === "SUSPENDED";

  return <>
    <nav className={styles.breadcrumbs} aria-label="Breadcrumb"><Link href="/staff/customers">Customers</Link><span aria-hidden="true">/</span><span>{detail.customer.name || "Customer"}</span></nav>
    <header className={styles.header}>
      <div><h1>{detail.customer.name || "Name not provided"}</h1><p>{detail.customer.email}</p></div>
      <span className={isSuspended ? styles.suspended : styles.active}>{isSuspended ? "Account suspended" : "Account active"}</span>
    </header>
    {updated === "account" && <p role="status" className={styles.notice}>{isSuspended ? "Account suspended. Active sign-in sessions were revoked." : "Account reactivated. The customer must sign in again."}</p>}
    {updated === "membership" && <p role="status" className={styles.notice}>Organization membership updated.</p>}
    {updated === "unchanged" && <p role="status" className={styles.notice}>No change was needed.</p>}
    {error && <p role="alert" className={styles.error}>{error === "account" ? "Account status could not be changed. Refresh the customer record and try again." : "Membership could not be changed. Refresh the customer record; the last active Owner cannot be removed or demoted."}</p>}

    <nav className={styles.customerActions} aria-label="Customer management actions">
      <Link href="#account-access-heading">Manage account access</Link>
      <Link href="#organization-memberships-heading">Manage organization memberships</Link>
    </nav>

    <div className={styles.summaryGrid}>
      <section className={styles.section}>
        <h2>Customer details</h2>
        <dl className={styles.details}>
          <div><dt>Email</dt><dd>{detail.customer.email}</dd></div>
          <div><dt>Email status</dt><dd>{detail.customer.emailVerified ? "Verified" : "Not verified"}</dd></div>
          <div><dt>Customer since</dt><dd>{formatDate(detail.customer.joinedAt)}</dd></div>
          <div><dt>Organizations</dt><dd>{detail.memberships.length}</dd></div>
        </dl>
      </section>
      <section className={`${styles.section} ${styles.accessSection}`} aria-labelledby="account-access-heading">
        <h2 id="account-access-heading" tabIndex={-1}>Account access</h2>
        <p>{isSuspended ? "This customer cannot sign in or use the customer workspace." : "This customer can sign in where an active organization membership allows access."}</p>
        {detail.customer.changedAt && <p className={styles.muted}>Last changed {formatDate(detail.customer.changedAt)} · {detail.customer.reasonCode?.replaceAll("_", " ").toLowerCase()}</p>}
        <form action={setCustomerAccountStateAction} className={styles.actionForm}>
          <input type="hidden" name="customerId" value={detail.customer.id} />
          <input type="hidden" name="expectedState" value={detail.customer.accountState} />
          <input type="hidden" name="state" value={isSuspended ? "ACTIVE" : "SUSPENDED"} />
          <label>Reason
            <select name="reason" defaultValue="" required>
              <option value="" disabled>Select a reason</option>{accountReasons.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className={styles.confirm}><input type="checkbox" name="confirmed" required />
            {isSuspended ? "Confirm account reactivation" : "Suspend access and revoke active sessions"}
          </label>
          <button type="submit" className={isSuspended ? styles.primaryButton : styles.dangerButton}>{isSuspended ? "Reactivate account" : "Suspend account"}</button>
        </form>
        <p className={styles.muted}>Suspension does not cancel existing orders or change organization funds. Password resets and customer profile edits remain customer-managed.</p>
      </section>
    </div>

    <section className={styles.section} aria-labelledby="wallet-balances-heading">
      <div className={styles.sectionHeading}>
        <div><h2 id="wallet-balances-heading">Organization wallet balances</h2>
          <p>Shared USD balances for this customer’s active memberships in open organizations. These funds belong to each organization, not to the individual customer.</p>
        </div>
      </div>
      {!detail.walletBalances.length ? <p className={styles.emptyInline}>No active organization wallet balances are available.</p> : <ul className={styles.walletList}>
        {detail.walletBalances.map((wallet) => <li className={styles.walletCard} key={wallet.organizationId}>
          <div><h3>{wallet.organizationName}</h3><span>Shared organization balance · {wallet.currency}</span></div>
          <strong>{formatUsdBalance(wallet.balanceMinor)}</strong>
        </li>)}
      </ul>}
      <p className={styles.muted}>This is the current balance projection. Holds can reduce what is available to spend; the underlying holds, ledger, funding history, and payment evidence are not shown here.</p>
    </section>

    <section className={styles.section} aria-labelledby="organization-memberships-heading">
      <div className={styles.sectionHeading}><div><h2 id="organization-memberships-heading" tabIndex={-1}>Organization memberships</h2><p>Manage the customer’s role and access in each organization. At least one active Owner must remain.</p></div></div>
      {!detail.memberships.length ? <p className={styles.emptyInline}>No organization memberships are recorded.</p> : <div className={styles.membershipList}>
        {detail.memberships.map((membership) => {
          const closed = Boolean(membership.closedAt);
          return <article className={styles.membership} key={membership.id}>
            <div className={styles.membershipHeading}>
              <div><h3>{membership.organizationName}</h3><p>{membership.role === "OWNER" ? "Owner" : "Member"} · joined {formatDate(membership.joinedAt)}</p></div>
              <span className={membership.active && !closed ? styles.active : styles.inactive}>{closed ? "Organization closed" : membership.active ? "Active membership" : "Inactive membership"}</span>
            </div>
            <form action={updateCustomerMembershipAction} className={styles.membershipForm}>
              <input type="hidden" name="customerId" value={detail.customer.id} />
              <input type="hidden" name="organizationId" value={membership.organizationId} />
              <input type="hidden" name="expectedRole" value={membership.role} />
              <input type="hidden" name="expectedActive" value={String(membership.active)} />
              <label>Organization role<select name="role" defaultValue={membership.role} disabled={closed}><option value="OWNER">Owner</option><option value="MEMBER">Member</option></select></label>
              <label>Membership access<select name="active" defaultValue={String(membership.active)} disabled={closed}><option value="true">Active</option><option value="false">Inactive</option></select></label>
              <label>Reason<select name="reason" defaultValue="" required disabled={closed}><option value="" disabled>Select a reason</option>{membershipReasons.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className={styles.confirm}><input type="checkbox" name="confirmed" required disabled={closed} />Confirm membership change</label>
              <button type="submit" disabled={closed}>Save membership</button>
            </form>
            {membership.role === "OWNER" && membership.active && !closed && <p className={styles.muted}>This is an active Owner. The database blocks changes that would leave the organization without an active Owner.</p>}
          </article>;
        })}
      </div>}
    </section>

    <div className={styles.activityGrid}>
      <section className={styles.section}>
        <div className={styles.sectionHeading}><div><h2>Orders placed by this customer</h2><p>Customer-safe order status only; order content stays in its assigned workflow.</p></div><Link href="/staff/fulfillment">Fulfillment queue</Link></div>
        {!detail.orders.length ? <p className={styles.emptyInline}>No paid orders were placed by this customer.</p> : <ul className={styles.activityList}>{detail.orders.map((order) => <li key={order.id}>
          <div><strong>Order {order.id.slice(0, 8)}</strong><span>{order.itemCount} {order.itemCount === 1 ? "item" : "items"} · {formatDate(order.createdAt)}</span></div>
          <span className={styles.status}>{order.status.replaceAll("_", " ").toLowerCase()}</span>
        </li>)}</ul>}
      </section>
      <section className={styles.section}>
        <div className={styles.sectionHeading}><div><h2>Support cases</h2><p>Cases opened by this customer.</p></div><Link href="/staff/support">Support queue</Link></div>
        {!detail.supportCases.length ? <p className={styles.emptyInline}>No support cases were opened by this customer.</p> : <ul className={styles.activityList}>{detail.supportCases.map((supportCase) => <li key={supportCase.id}>
          <div><Link href={`/staff/support/${supportCase.id}`}><strong>{supportCase.summary}</strong></Link><span>{supportCase.state.replaceAll("_", " ").toLowerCase()} · updated {formatDate(supportCase.updatedAt)}</span></div>
          <Link href={`/staff/support/${supportCase.id}`}>Open case</Link>
        </li>)}</ul>}
      </section>
    </div>

    <section className={styles.section}>
      <div className={styles.sectionHeading}><div><h2>Organization closure requests</h2><p>Existing Support workflow; closure cannot proceed while required financial or operational blockers remain.</p></div><Link href="/staff/support">Support</Link></div>
      {!detail.closureRequests.length ? <p className={styles.emptyInline}>No closure requests for this customer’s organizations.</p> : <ul className={styles.activityList}>{detail.closureRequests.map((request) => <li key={request.id}>
        <div><strong>{request.organizationName}</strong><span>{request.summary} · {request.state.replaceAll("_", " ").toLowerCase()}</span></div>
        <Link href={`/staff/support/closures/${request.id}`}>Review request</Link>
      </li>)}</ul>}
    </section>
  </>;
}
