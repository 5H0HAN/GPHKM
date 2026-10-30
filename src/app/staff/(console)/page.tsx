import { headers } from "next/headers";
import Link from "next/link";
import { requireStaffAccess } from "@/server/auth/staff";
import { hasStaffPermission, type StaffPermission } from "@/server/identity/policy";
import { getStaffOperationsAlerts } from "@/server/observability/operations-alerts";
import styles from "./staff.module.css";

export default async function StaffOverview() {
  const requestHeaders = await headers();
  const actor = await requireStaffAccess(requestHeaders, "audit.read");
  const operationsAlerts = await getStaffOperationsAlerts(requestHeaders, actor.role);
  const roleContent = {
    ADMIN: { title: "Fulfillment workspace", lede: "Move assigned placements forward, review customer requests, and keep listing details current." },
    FINANCE: { title: "Finance workspace", lede: "Reconcile wallet events, review refund cases, and keep supplier cost records supported by evidence." },
    SUPER_ADMIN: { title: "Operations overview", lede: "Review priority work across fulfillment, customer support, finance controls, and staff access." },
  } as const;
  const areas: { permission: StaffPermission; label: string; title: string; description: string; href: string; action: string }[] = [
    { permission: "catalog.manage", label: "Catalog", title: "Listings & inventory", description: "Review staged inventory, approve customer-facing terms, and control what is live.", href: "/staff/catalog", action: "Open catalog" },
    { permission: "supplier.manage", label: "Inventory sources", title: "Suppliers & imports", description: "Manage private supplier contacts and review uploaded or synced inventory.", href: "/staff/suppliers", action: "Open suppliers" },
    { permission: "fulfillment.manage", label: "Order operations", title: "Fulfillment queue", description: "Review assigned item work, update customers, and verify publication links.", href: "/staff/fulfillment", action: "Open fulfillment" },
    { permission: "fulfillment.manage", label: "Order operations", title: "Handoff reconciliation", description: "Resolve unclear send outcomes, delivery issues, and overdue acknowledgements.", href: "/staff/fulfillment/packets/reconciliation", action: "Review handoffs" },
    { permission: "audit.read", label: actor.role === "FINANCE" ? "Finance review" : "Customer care", title: actor.role === "FINANCE" ? "Refund review cases" : "Support cases", description: actor.role === "FINANCE" ? "Review cases referred for financial review. Decisions stay private and do not execute wallet refunds." : "Review customer requests, send customer-safe updates, and track case decisions.", href: "/staff/support", action: actor.role === "FINANCE" ? "Open finance review" : "Open Support" },
    { permission: "metrics.refresh", label: "Catalog quality", title: "Domain metrics", description: "Refresh approved provider metrics and review listing data that needs attention.", href: "/staff/metrics", action: "Open metrics" },
    { permission: "supplier-report.export", label: "Supplier review", title: "Supplier performance", description: "Compare 90-day fulfillment outcomes with sample sizes and exportable detail.", href: "/staff/suppliers/performance", action: "Review performance" },
    { permission: "wallet.reconcile", label: "Finance controls", title: "Stripe reconciliation", description: "Review Stripe funding exceptions, unmatched events, and active wallet holds.", href: "/staff/reconciliation", action: "Open reconciliation" },
    { permission: "staff.manage", label: "Access control", title: "Staff access", description: "Review staff roles, require MFA before activation, and revoke access when needed.", href: "/staff/team", action: "Manage staff" },
    { permission: "supplier-report.export", label: "Order operations", title: "Supplier notice reconciliation", description: "Review stop or correction notices that need a recorded delivery outcome.", href: "/staff/support/notices/reconciliation", action: "Review notices" },
    { permission: "costs.read", label: "Finance", title: "Supplier costs & payments", description: "Review direct costs, record manual supplier payments with evidence, and inspect margin.", href: "/staff/suppliers/finance", action: "Open cost records" },
    { permission: "costs.read", label: "Finance", title: "Gross profit", description: "Review retail revenue, refunds, recorded direct costs, and provisional margins.", href: "/staff/suppliers/finance/margins", action: "Open gross profit" },
    { permission: "access-policy.manage", label: "Customer access", title: "Browsing access", description: "Review the active marketplace access policy and set terms for future grants.", href: "/staff/access-policy", action: "Manage access policy" },
    { permission: "audit.read", label: "Control", title: "Audit trail", description: "Review append-only staff and financial events within your role’s access.", href: "/staff/audit", action: "Open audit trail" },
  ];
  const visibleAreas = areas.filter((area) => hasStaffPermission(actor.role, area.permission));
  return (
    <>
      <header className={styles.header}>
        <div><h1>{roleContent[actor.role].title}</h1><p className={styles.lede}>{roleContent[actor.role].lede}</p></div>
      </header>
      <div className={styles.dashboard}>
        <section className={styles.workPanel} aria-label="Operational areas">
          <div className={styles.sectionHeader}><h2>Work areas</h2><span>{visibleAreas.length} available</span></div>
          <div className={styles.areaList}>
            {visibleAreas.map((area) => <article className={styles.card} key={area.href}>
              <span className={styles.cardMark} aria-hidden="true" />
              <div className={styles.areaCopy}><span className={styles.cardLabel}>{area.label}</span><h3>{area.title}</h3><p>{area.description}</p></div>
              <Link className={styles.cardAction} href={area.href}>{area.action}<span aria-hidden="true">↗</span></Link>
            </article>)}
          </div>
        </section>
        <aside className={styles.alertSection} aria-label="Operations needing attention">
          <div className={styles.alertHeader}><h2>Needs attention</h2><span>{operationsAlerts.length}</span></div>
          {operationsAlerts.length ? <ul className={styles.alertList}>{operationsAlerts.map((alert) => <li className={styles.alert} key={alert.key}>
            <div><strong>{alert.title}</strong><p>{alert.description}</p></div>
            <span className={styles.alertCount}>{alert.saturated ? `${alert.count}+` : alert.count}</span>
            <Link className={styles.cardAction} href={alert.href}>Review queue<span aria-hidden="true">↗</span></Link>
          </li>)}</ul> : <p className={styles.alertEmpty}>No open application queues need attention.</p>}
          <p className={styles.alertFootnote}>Queue counts update when this page loads. Infrastructure health is monitored separately from this work queue.</p>
          <div className={styles.notice}><span className={styles.noticeDot} /><p>Private order content is limited to assigned Admins and audited Super Admin access.</p></div>
        </aside>
      </div>
    </>
  );
}
