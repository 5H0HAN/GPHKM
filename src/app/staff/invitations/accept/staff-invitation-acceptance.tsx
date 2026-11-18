"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { staffAuthClient } from "@/auth/staff-client";
import { TotpEnrollmentForm } from "@/components/identity/totp-enrollment-form";
import { BackupCodesPanel } from "@/components/identity/totp-secret-panel";
import { useOneTimeLinkFragment } from "@/components/identity/use-one-time-link-fragment";
import { useStepHeading } from "@/components/identity/use-step-heading";
import styles from "@/components/identity/invitation-acceptance.module.css";

export function StaffInvitationAcceptance({ alreadyAccepted, localMfaBypassed }: {
  alreadyAccepted: boolean;
  localMfaBypassed: boolean;
}) {
  const [fragment, clearFragment] = useOneTimeLinkFragment();
  const [stage, setStage] = useState<"signup" | "accept" | "setup">("signup");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const heading = useStepHeading(stage);
  const token = fragment?.get("token") ?? "";
  const hasToken = /^[A-Za-z0-9_-]{40,64}$/.test(token);
  const invitedEmail = fragment?.get("email")?.slice(0, 254) ?? "";

  async function acceptInvitation() {
    const response = await fetch("/api/staff/invitations/accept", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const payload = await response.json().catch(() => null) as { accepted?: boolean } | null;
    if (!response.ok || payload?.accepted !== true) {
      setError("The invitation could not be accepted. Sign in with the invited address and check that the link is still current.");
      return;
    }
    clearFragment();
    setStage("setup");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !hasToken) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const password = String(values.get("password") ?? "");
    if (password !== String(values.get("confirmPassword") ?? "")) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await staffAuthClient.signUp.email({
        name: String(values.get("name") ?? "").trim(),
        email: String(values.get("email") ?? "").trim(),
        password,
        fetchOptions: { headers: { "x-gphkm-staff-invitation-token": token } },
      });
      if (result.error) {
        if (["USER_ALREADY_EXISTS", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"].includes(result.error.code ?? "")) {
          setStage("accept");
          setError("This email already has an account. If it hasn’t joined a customer organization, sign in to the staff workspace or request a password reset, then return here to accept the invitation.");
        } else {
          setError("Staff account setup could not start. Check the invited email and try again.");
        }
        return;
      }
      form.reset();
      setStage("accept");
      await acceptInvitation();
    } catch {
      setError("The invitation could not be completed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function retryAcceptance() {
    if (busy || !hasToken) return;
    setBusy(true);
    setError("");
    try {
      await acceptInvitation();
    } catch {
      setError("The invitation could not be accepted right now. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return <main className={styles.page}>
    <section className={styles.panel} aria-label="Staff invitation">
      <span role="status" className={styles.copy}>
        {busy ? "Completing your invitation…" : !alreadyAccepted && fragment === null ? "Checking your invitation…" : ""}
      </span>
      {alreadyAccepted ? <>
        <h1>Staff account already set up</h1>
        <p className={styles.copy}>Your signed-in staff account has already accepted an invitation.</p>
        <Link className={styles.link} href="/staff/sign-in">Continue to staff sign-in</Link>
    </> : stage === "setup" ? backupCodes ? <>
        <h1 ref={heading} tabIndex={-1}>Save your staff recovery codes</h1>
        <BackupCodesPanel codes={backupCodes} showHeading={false} />
        <p role="status" className={styles.note}>A Super Admin must activate your account after your authenticator is set up.</p>
        <Link className={styles.link} href="/staff/sign-in">Continue to staff sign-in</Link>
      </> : localMfaBypassed ? <>
        <h1 ref={heading} tabIndex={-1}>Staff invitation accepted</h1>
        <p role="status" className={styles.note}>Local MFA bypass is enabled. Seed a local staff factor before testing database activation.</p>
        <Link className={styles.link} href="/staff/sign-in">Continue to staff sign-in</Link>
      </> : <>
        <h1 ref={heading} tabIndex={-1}>Set up staff sign-in verification</h1>
        <p className={styles.copy}>Your account stays inactive until a Super Admin activates it. Set up an authenticator and save the one-time recovery codes first.</p>
        <TotpEnrollmentForm surface="staff" onVerified={setBackupCodes} />
      </> : <>
        <h1 ref={heading} tabIndex={-1}>{stage === "accept" ? "Finish accepting your staff invitation" : "Accept your staff invitation"}</h1>
        {fragment === null ? null : !hasToken ? <>
          <p className={styles.copy}>Open the latest invitation email to continue.</p>
          <Link className={styles.link} href="/staff/sign-in">Go to staff sign-in</Link>
        </> : stage === "signup" ? <>
          <p className={styles.copy}>Use the invited email address and choose a password with at least 16 characters. A Super Admin must activate your account after you accept the invitation.</p>
          {error && <p role="alert" className={styles.error}>{error}</p>}
          <form className={styles.form} method="post" onSubmit={submit} aria-busy={busy}>
            <label>Your name<input name="name" type="text" autoComplete="name" maxLength={100} required disabled={busy} /></label>
            <label>Invited email<input name="email" type="email" autoComplete="email" spellCheck={false} maxLength={254} defaultValue={invitedEmail} required disabled={busy} /></label>
            <label>Create password<input name="password" type="password" autoComplete="new-password" minLength={16} maxLength={128} required disabled={busy} /></label>
            <label>Confirm password<input name="confirmPassword" type="password" autoComplete="new-password" minLength={16} maxLength={128} required disabled={busy} /></label>
            <button className={styles.primary} type="submit" disabled={busy}>{busy ? "Please wait…" : "Create staff account"}</button>
          </form>
          <button className={styles.textButton} type="button" disabled={busy} onClick={() => { setError(""); setStage("accept"); }}>I already have a staff password</button>
        </> : <>
          <p className={styles.copy}>If you need to sign in, open staff sign-in in a new tab. Return here to accept the invitation.</p>
          {error && <p role="alert" className={styles.error}>{error}</p>}
          <Link className={styles.link} href="/staff/sign-in" target="_blank" rel="noreferrer">Open staff sign-in in a new tab</Link>
          <button className={styles.button} type="button" onClick={retryAcceptance} disabled={busy}>{busy ? "Accepting…" : "Accept staff invitation"}</button>
          <button className={styles.textButton} type="button" disabled={busy} onClick={() => { setError(""); setStage("signup"); }}>Back to account setup</button>
        </>}
      </>}
    </section>
  </main>;
}
