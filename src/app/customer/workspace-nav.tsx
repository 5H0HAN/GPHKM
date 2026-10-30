"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { chooseOrganizationId } from "@/modules/identity/organizations";
import styles from "./customer.module.css";

const navigation = [
  { href: "/customer", label: "Overview", icon: "⌂" },
  { href: "/customer/catalog", label: "Marketplace", icon: "◇" },
  { href: "/customer/orders", label: "Orders", icon: "≡" },
  { href: "/customer/notifications", label: "Notifications", icon: "◷" },
  { href: "/customer/support", label: "Support", icon: "?" },
  { href: "/customer/wallet", label: "Wallet", icon: "◉" },
  { href: "/customer/settings", label: "Settings", icon: "⚙" },
];

export function WorkspaceNav({ organizations }: { organizations: { id: string }[] }) {
  const pathname = usePathname();
  const query = useSearchParams();
  const organizationId = chooseOrganizationId(organizations, query.get("organizationId"));
  return (
    <nav className={styles.nav} aria-label="Main navigation">
      {navigation.map((item) => (
        <Link className={styles.navLink} href={organizationId ? `${item.href}?organizationId=${encodeURIComponent(organizationId)}` : item.href} key={item.href} aria-current={pathname === item.href || (item.href !== "/customer" && pathname.startsWith(`${item.href}/`)) ? "page" : undefined}>
          <span className={styles.navIcon} aria-hidden="true">{item.icon}</span>{item.label}
        </Link>
      ))}
    </nav>
  );
}
