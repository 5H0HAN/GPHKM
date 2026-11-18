"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SignInSession } from "@/server/auth/sign-in-session";
import { StaffSignOut } from "../(console)/staff-signout";
import SignInForm from "../../sign-in/sign-in-form";
import { TotpEnrollmentForm } from "@/components/identity/totp-enrollment-form";
import { BackupCodesPanel } from "@/components/identity/totp-secret-panel";
import styles from "./sign-in.module.css";

export function StaffSignIn({ session, staff, localEnabled, localMfaBypassed, passwordResetEnabled }: {
  session: SignInSession;
  staff: { active: boolean; twoFactorEnabled: boolean } | null;
  localEnabled: boolean;
  localMfaBypassed: boolean;
  passwordResetEnabled: boolean;
}) {
  const router = useRouter();
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  if (!session) return <SignInForm
    localEnabled={localEnabled}
    emailPasswordEnabled
    emailSignupEnabled={false}
    googleEnabled={false}
    passwordResetEnabled={passwordResetEnabled}
    returnTo="/staff/sign-in"
    surface="staff"
  />;

  if (!staff) return <>
    <h1>Finish accepting your invitation</h1>
    <p className={styles.note}>Open the link in your latest staff invitation email to continue.</p>
    <StaffSignOut buttonClassName={styles.secondary} />
  </>;

  if (!localMfaBypassed && !staff.twoFactorEnabled) return backupCodes ? <>
    <h1>Save your staff recovery codes</h1>
    <BackupCodesPanel codes={backupCodes} showHeading={false} />
    <div className={styles.actions}>
      <button className={styles.secondary} type="button" onClick={() => { setBackupCodes(null); router.refresh(); }}>Done</button>
    </div>
  </> : <>
    <h1>Set up staff sign-in verification</h1>
    <p className={styles.note}>Scan the authenticator QR code and verify a code. Staff access stays blocked until setup is complete.</p>
    <TotpEnrollmentForm surface="staff" onVerified={setBackupCodes} />
    <StaffSignOut buttonClassName={styles.secondary} />
  </>;

  if (!staff.active) return backupCodes ? <>
    <h1>Save your staff recovery codes</h1>
    <BackupCodesPanel codes={backupCodes} showHeading={false} />
    <div className={styles.actions}>
      <button className={styles.secondary} type="button" onClick={() => { setBackupCodes(null); router.refresh(); }}>Done</button>
    </div>
  </> : <>
    <h1>Awaiting Super Admin activation</h1>
    <p className={styles.note}>{localMfaBypassed
      ? "A Super Admin must activate your account before you can open the staff workspace."
      : "Your account has a verified email and authenticator. A Super Admin must activate it before you can open the staff workspace."}</p>
    <StaffSignOut buttonClassName={styles.secondary} />
  </>;

  return <>
    <h1>Staff access active</h1>
    <p className={styles.note}>Your staff session is ready.</p>
    <div className={styles.actions}>
      <Link href="/staff" className={styles.secondary}>Open staff workspace</Link>
      <StaffSignOut buttonClassName={styles.secondary} />
    </div>
  </>;
}
