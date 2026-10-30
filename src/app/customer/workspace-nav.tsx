"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { chooseOrganizationId } from "@/modules/identity/organizations";
import styles from "./customer.module.css";

const groups = [
  { label: "Workspace", items: [
    { href: "/customer", label: "Overview" },
    { href: "/customer/catalog", label: "Marketplace" },
    { href: "/customer/orders", label: "Orders" },
  ] },
  { label: "Manage", items: [
    { href: "/customer/wallet", label: "Wallet" },
    { href: "/customer/notifications", label: "Notifications" },
    { href: "/customer/support", label: "Support" },
    { href: "/customer/settings", label: "Settings" },
  ] },
];

export function WorkspaceNav({ organizations }: { organizations: { id: string }[] }) {
  const pathname = usePathname();
  const query = useSearchParams();
  const [open, setOpen] = useState(false);
  const organizationId = chooseOrganizationId(organizations, query.get("organizationId"));
  return (
    <div className={styles.navShell}>
      <button className={styles.mobileMenuToggle} type="button" aria-expanded={open} aria-controls="customer-workspace-navigation" onClick={() => setOpen((value) => !value)}>
        {open ? "Close menu" : "Open menu"}
      </button>
      <nav className={styles.nav} id="customer-workspace-navigation" data-open={open} aria-label="Main navigation">
        {groups.map((group) => <div className={styles.navGroup} key={group.label}>
          <p className={styles.navGroupLabel}>{group.label}</p>
          <div className={styles.navGroupLinks}>{group.items.map((item) => (
            <Link className={styles.navLink} href={organizationId ? `${item.href}?organizationId=${encodeURIComponent(organizationId)}` : item.href} key={item.href} aria-current={pathname === item.href || (item.href !== "/customer" && pathname.startsWith(`${item.href}/`)) ? "page" : undefined} onClick={() => setOpen(false)}>
              <span className={styles.navGlyph} aria-hidden="true" />{item.label}
            </Link>
          ))}</div>
        </div>)}
      </nav>
    </div>
  );
}
