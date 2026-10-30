import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireStaffAccess } from "@/server/auth/staff";
import { hasStaffPermission, type StaffPermission } from "@/server/identity/policy";
import styles from "./console.module.css";
import Link from "next/link";
import { StaffSignOut } from "./staff-signout";
import { StaffNav } from "./staff-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { readAppearancePreference } from "@/server/identity/appearance";

const navigation: { group: string; label: string; href: string; permission: StaffPermission }[] = [
  { group: "Work", label: "Overview", href: "/staff", permission: "audit.read" },
  { group: "Work", label: "Listings", href: "/staff/catalog", permission: "catalog.manage" },
  { group: "Work", label: "Suppliers & imports", href: "/staff/suppliers", permission: "supplier.manage" },
  { group: "Operations", label: "Fulfillment", href: "/staff/fulfillment", permission: "fulfillment.manage" },
  { group: "Operations", label: "Support", href: "/staff/support", permission: "audit.read" },
  { group: "Operations", label: "Domain metrics", href: "/staff/metrics", permission: "metrics.refresh" },
  { group: "Operations", label: "Supplier performance", href: "/staff/suppliers/performance", permission: "supplier-report.export" },
  { group: "Finance", label: "Reconciliation", href: "/staff/reconciliation", permission: "wallet.reconcile" },
  { group: "Finance", label: "Supplier costs & payments", href: "/staff/suppliers/finance", permission: "costs.read" },
  { group: "Finance", label: "Gross profit", href: "/staff/suppliers/finance/margins", permission: "costs.read" },
  { group: "Control", label: "Browsing access", href: "/staff/access-policy", permission: "access-policy.manage" },
  { group: "Control", label: "Audit trail", href: "/staff/audit", permission: "audit.read" },
  { group: "Control", label: "Staff access", href: "/staff/team", permission: "staff.manage" },
];

export default async function ConsoleLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  let actor;
  try { actor = await requireStaffAccess(requestHeaders, "audit.read"); }
  catch { redirect("/staff/sign-in"); }
  const appearance = await readAppearancePreference(actor.userId);
  const visibleNavigation = navigation.filter((item) => hasStaffPermission(actor.role, item.permission));
  const navigationGroups = [...new Set(visibleNavigation.map((item) => item.group))].map((group) => ({
    label: group,
    items: visibleNavigation.filter((item) => item.group === group),
  }));

  return (
    <div className={styles.frame} data-theme={appearance.toLowerCase()}>
      <a className={styles.skipLink} href="#staff-main">Skip to main content</a>
      <aside className={styles.sidebar}>
        <Link href="/staff" className={styles.brand}>GPHKM <span>OPS</span></Link>
        <div className={styles.appearance}><ThemeToggle initialTheme={appearance} /></div>
        <StaffNav groups={navigationGroups} />
        <div className={styles.sidebarBottom}>
          <p>Signed in as</p><strong>{actor.role.replaceAll("_", " ")}</strong>
          <StaffSignOut />
        </div>
      </aside>
      <main className={styles.main} id="staff-main">{children}</main>
    </div>
  );
}
