import Link from "next/link";
import styles from "./sign-in.module.css";
import { localAuthEnabled } from "@/server/auth/policy";
import { getSignInSession } from "@/server/auth/sign-in-session";
import { StaffSignIn } from "./staff-sign-in";

export const dynamic = "force-dynamic";

export default async function StaffSignInPage() {
  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const session = await getSignInSession("staff");
  return (
    <main className={styles.page}>
      <a className={styles.skipLink} href="#staff-title">Skip to sign-in form</a>
      <Link className={styles.brand} href="/">GPHKM <span>STAFF</span></Link>
      <section className={styles.panel} aria-labelledby="staff-title">
        <p className={styles.eyebrow}>STAFF WORKSPACE</p>
        <div id="staff-title" className={styles.form} tabIndex={-1}><StaffSignIn session={session} localEnabled={localAuthEnabled(process.env)} googleEnabled={googleEnabled} /></div>
        <p className={styles.note}>Staff access requires an active account and verified MFA.</p>
      </section>
    </main>
  );
}
