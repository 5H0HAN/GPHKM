"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import styles from "./console.module.css";

export function StaffNav({ groups }: { groups: { label: string; items: { label: string; href: string }[] }[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  return <div className={styles.desktopNav}>
    <button className={styles.mobileMenuToggle} type="button" aria-expanded={open} aria-controls="staff-workspace-navigation" onClick={() => setOpen((value) => !value)}>
      {open ? "Close menu" : "Open menu"}
    </button>
    <nav id="staff-workspace-navigation" data-open={open} aria-label="Staff workspace">
      {groups.map((group) => <section className={styles.navGroup} key={group.label} aria-label={group.label}>
        <p className={styles.sectionLabel}>{group.label}</p>
        {group.items.map((item) => <Link
          className={styles.navLink}
          href={item.href}
          key={item.href}
          aria-current={pathname === item.href || (item.href !== "/staff" && pathname.startsWith(`${item.href}/`)) ? "page" : undefined}
          onClick={() => setOpen(false)}
        ><span className={styles.navGlyph} aria-hidden="true" />{item.label}</Link>)}
      </section>)}
    </nav>
  </div>;
}
