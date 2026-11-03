import { headers } from "next/headers";
import { requireStaffAccess } from "@/server/auth/staff";
import type { StaffRole } from "@/server/identity/policy";
import { getStaffOperationsAlerts } from "@/server/observability/operations-alerts";
import { OverviewInbox } from "./overview-inbox";
import styles from "./staff.module.css";

export default async function StaffOverview() {
  const requestHeaders = await headers();
  const actor = await requireStaffAccess(requestHeaders, "audit.read");
  const operationsAlerts = await getStaffOperationsAlerts(requestHeaders, actor);
  const roleContent = {
    ADMIN: { title: "Fulfillment workspace", lede: "Review assigned work, customer follow-ups, and Support cases that need your action." },
    FINANCE: { title: "Finance workspace", lede: "Review wallet exceptions and Support cases awaiting a Finance decision." },
    SUPER_ADMIN: { title: "Operations overview", lede: "Review open staff work across fulfillment, Support, supplier handoffs, and finance controls." },
  } satisfies Record<StaffRole, { title: string; lede: string }>;
  return (
    <>
      <header className={styles.header}>
        <div><h1>{roleContent[actor.role].title}</h1><p className={styles.lede}>{roleContent[actor.role].lede}</p></div>
      </header>
      <div className={styles.dashboard}>
        <OverviewInbox initialAlerts={operationsAlerts} initialCheckedAt={new Date().toISOString()} />
      </div>
    </>
  );
}
