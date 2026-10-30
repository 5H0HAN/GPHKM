import Link from "next/link";
import styles from "./sign-in.module.css";
import { localAuthEnabled } from "@/server/auth/policy";
import { getSignInSession } from "@/server/auth/sign-in-session";
import { StaffSignIn } from "./staff-sign-in";
import { localStaffMfaDisabled } from "@/server/auth/policy";
import { requireStaffAccess } from "@/server/auth/staff";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function StaffSignInPage() {
  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const session = await getSignInSession("staff");
  let workspaceReady = false;
  if (session) {
    try {
      await requireStaffAccess(await headers(), "audit.read");
      workspaceReady = true;
    } catch { /* Unverified or inactive staff remain on the staff verification screen. */ }
  }
  if (workspaceReady) redirect("/staff");
  const localMfaDisabled = localStaffMfaDisabled(process.env);
  return (
    <main className={styles.page}>
      <a className={styles.skipLink} href="#staff-title">Skip to sign-in form</a>
      <Link className={styles.brand} href="/">GPHKM <span>STAFF</span></Link>
      <section className={styles.panel} aria-labelledby="staff-title">
        <p className={styles.eyebrow}>STAFF WORKSPACE</p>
        <div id="staff-title" className={styles.form} tabIndex={-1}><StaffSignIn session={session} localEnabled={localAuthEnabled(process.env)} localMfaDisabled={localMfaDisabled} googleEnabled={googleEnabled} /></div>
        <p className={styles.note}>{localMfaDisabled ? "Local testing: staff MFA is disabled for this development environment." : "Staff access requires an active account and verified MFA."}</p>
      </section>
    </main>
  );
}
