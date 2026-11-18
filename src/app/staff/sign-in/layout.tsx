import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./sign-in.module.css";

export default function StaffSignInLayout({ children }: { children: ReactNode }) {
  return (
    <main className={styles.page}>
      <a className={styles.skipLink} href="#staff-sign-in-panel">Skip to sign-in form</a>
      <Link className={styles.brand} href="/staff/sign-in" aria-label="GPHKM staff sign-in">GPHKM <span>Staff</span></Link>
      <section id="staff-sign-in-panel" className={styles.panel} tabIndex={-1}>{children}</section>
    </main>
  );
}
