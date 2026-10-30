"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./console.module.css";

export function StaffNav({ items }: { items: { label: string; href: string }[] }) {
  const pathname = usePathname();
  return <nav aria-label="Staff workspace">
    {items.map((item) => <Link
      className={styles.navLink}
      href={item.href}
      key={item.href}
      aria-current={pathname === item.href || (item.href !== "/staff" && pathname.startsWith(`${item.href}/`)) ? "page" : undefined}
    >{item.label}</Link>)}
  </nav>;
}
