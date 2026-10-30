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
  const greeting = actor.role === "SUPER_ADMIN" ? "Operations overview" : `${actor.role.replaceAll("_", " ").toLowerCase()} overview`;
  const areas: { permission: StaffPermission; label: string; title: string; description: string; href: string; action: string }[] = [
    { permission: "catalog.manage", label: "CATALOG", title: "Listings & inventory", description: "Review staged inventory, approve customer-facing terms, and control what is live.", href: "/staff/catalog", action: "Open catalog" },
    { permission: "fulfillment.manage", label: "ORDER OPERATIONS", title: "Fulfillment queue", description: "Assign placements, review item work, update customers, and verify publication links.", href: "/staff/fulfillment", action: "Open fulfillment" },
    { permission: "audit.read", label: actor.role === "FINANCE" ? "FINANCE CASE REVIEW" : "CUSTOMER CARE", title: actor.role === "FINANCE" ? "Refund review cases" : "Support cases", description: actor.role === "FINANCE" ? "Review cases referred for financial review. Decisions stay private and do not execute wallet refunds." : "Review customer requests, send customer-safe updates, and track case decisions.", href: "/staff/support", action: actor.role === "FINANCE" ? "Open finance review" : "Open Support" },
    { permission: "wallet.reconcile", label: "FINANCE CONTROLS", title: "Stripe reconciliation", description: "Review Stripe funding exceptions, unmatched events, and active wallet holds.", href: "/staff/reconciliation", action: "Open reconciliation" },
    { permission: "staff.manage", label: "ACCESS CONTROL", title: "Staff access", description: "Review staff roles, require MFA before activation, and revoke access when needed.", href: "/staff/team", action: "Manage staff" },
    { permission: "costs.read", label: "FINANCE", title: "Supplier costs & payments", description: "Review direct costs, record manual supplier payments with evidence, and inspect margin.", href: "/staff/suppliers/finance", action: "Open cost records" },
    { permission: "audit.read", label: "CONTROL", title: "Audit trail", description: "Review append-only staff and financial events within your role’s access.", href: "/staff/audit", action: "Open audit trail" },
  ];
  const visibleAreas = areas.filter((area) => hasStaffPermission(actor.role, area.permission));
  return (
    <>
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>GPHKM OPERATIONS</p><h1>{greeting}</h1><p className={styles.lede}>Review work queues and keep each order moving with a clear audit trail.</p></div>
        <span className={styles.roleBadge}>{actor.role.replaceAll("_", " ")}</span>
      </header>
      <section className={styles.cards} aria-label="Operational areas">
        {visibleAreas.map((area) => <article className={styles.card} key={area.href}>
          <span className={styles.cardLabel}>{area.label}</span><h2>{area.title}</h2><p>{area.description}</p>
          <Link className={styles.cardAction} href={area.href}>{area.action} <span aria-hidden="true">→</span></Link>
        </article>)}
      </section>
      <section className={styles.alertSection} aria-label="Operations needing attention">
        <div className={styles.alertHeader}><div><p className={styles.eyebrow}>LIVE QUEUES</p><h2>Needs attention</h2></div><span>{operationsAlerts.length} active queues</span></div>
        {operationsAlerts.length ? <ul className={styles.alertList}>{operationsAlerts.map((alert) => <li className={styles.alert} key={alert.key}>
          <div><strong>{alert.title}</strong><p>{alert.description}</p></div>
          <span className={styles.alertCount}>{alert.saturated ? `${alert.count}+` : alert.count}</span>
          <Link className={styles.cardAction} href={alert.href}>Review queue <span aria-hidden="true">→</span></Link>
        </li>)}</ul> : <p className={styles.alertEmpty}>No open application queues need attention.</p>}
        <p className={styles.alertFootnote}>Counts refresh when this page loads. Database and backup provider alerts must be configured in Neon and Coolify before production.</p>
      </section>
      <section className={styles.notice} aria-label="Platform readiness">
        <span className={styles.noticeDot} />
        <div><strong>Protected operations</strong><p>Queues and tools are shown according to your active staff role. Private order content remains limited to the assigned Admin and audited Super Admin access.</p></div>
      </section>
    </>
  );
}
