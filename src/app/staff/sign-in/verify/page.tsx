import SignInForm from "../../../sign-in/sign-in-form";
import Link from "next/link";
import styles from "../sign-in.module.css";

export const dynamic = "force-dynamic";

export default function StaffMfaVerifyPage() {
  return (
    <main className={styles.page}>
      <a className={styles.skipLink} href="#staff-verify-title">Skip to verification form</a>
      <Link className={styles.brand} href="/">GPHKM <span>STAFF</span></Link>
      <section className={styles.panel} aria-labelledby="staff-verify-title">
        <p className={styles.eyebrow}>STAFF WORKSPACE</p>
        <div id="staff-verify-title" className={styles.form} tabIndex={-1}>
          <SignInForm session={null} localEnabled={false} googleEnabled={false} verify returnTo="/staff" surface="staff" />
        </div>
      </section>
    </main>
  );
}
