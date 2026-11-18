"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/auth/client";
import { TotpEnrollmentForm } from "@/components/identity/totp-enrollment-form";
import { BackupCodesPanel } from "@/components/identity/totp-secret-panel";
import { useStepHeading } from "@/components/identity/use-step-heading";
import customerStyles from "../customer.module.css";
import styles from "./settings.module.css";

export function TwoFactorSettings({ enabled, hasPassword }: { enabled: boolean; hasPassword: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"setup" | "regenerate" | "disable" | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const title = backupCodes ? "Save your backup codes" : mode === "setup" ? "Set up your authenticator"
    : mode === "regenerate" ? "Replace backup codes" : mode === "disable" ? "Disable two-factor verification" : "Two-factor verification";
  const heading = useStepHeading(title);

  function closeForm() {
    setMode(null);
    setError("");
  }

  async function finishSetup(codes: string[]) {
    setBackupCodes(codes);
    closeForm();
    try {
      const result = await authClient.revokeOtherSessions();
      if (result.error) throw new Error("Sessions unavailable");
      setNotice("Two-factor verification is on. Other sessions were signed out.");
    } catch {
      setNotice("Two-factor verification is on. Review other devices under Active sessions.");
    }
    router.refresh();
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (mode !== "regenerate" && mode !== "disable")) return;
    const form = event.currentTarget;
    const password = String(new FormData(form).get("currentPassword") ?? "");
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (mode === "regenerate") {
        const result = await authClient.twoFactor.generateBackupCodes({ password });
        if (result.error || !result.data?.backupCodes) {
          setError("Backup codes could not be replaced. Check your password and try again.");
          return;
        }
        setBackupCodes(result.data.backupCodes);
        setNotice("Backup codes replaced.");
      } else {
        const result = await authClient.twoFactor.disable({ password });
        if (result.error) {
          setError("Two-factor verification could not be disabled. Check your password and try again.");
          return;
        }
        setBackupCodes(null);
        setNotice("Two-factor verification is off.");
        router.refresh();
      }
      form.reset();
      closeForm();
    } catch {
      setError("The change could not be completed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <h3 ref={heading} tabIndex={-1} className={customerStyles.panelTitle}>{title}</h3>
    <p className={styles.securityCopy}><strong>{enabled || backupCodes ? "On" : "Off"}</strong></p>
    <p className={styles.securityCopy}>If you lose your authenticator, use a backup code. Google sign-in is unavailable while two-factor is enabled.</p>
    {!enabled && !hasPassword && <p className={styles.securityCopy}>You need a password before setting up an authenticator. <a href="#password">Go to Add password</a>.</p>}
    <span role="status" className={styles.passwordMessage}>{notice}</span>
    {backupCodes ? <>
      <BackupCodesPanel codes={backupCodes} showHeading={false} />
      <div className={styles.securityActions}><button type="button" onClick={() => setBackupCodes(null)}>Done</button></div>
    </> : mode === "setup" ? (
      <TotpEnrollmentForm onVerified={finishSetup} onCancel={closeForm} />
    ) : mode ? (
      <form key={mode} className={styles.passwordForm} method="post" onSubmit={submitPassword} aria-busy={busy}>
        <p className={styles.securityCopy}>{mode === "regenerate"
          ? "Generating new codes invalidates every existing backup code."
          : "Disabling two-factor verification lets you sign in without an authenticator or backup code."}</p>
        <label>Current password
          <input name="currentPassword" type="password" autoComplete="current-password" maxLength={128} required disabled={busy} />
        </label>
        {error && <p role="alert" className={styles.passwordError}>{error}</p>}
        <div className={styles.securityActions}>
          <button type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "regenerate" ? "Regenerate backup codes" : "Disable two-factor verification"}</button>
          <button type="button" onClick={closeForm} disabled={busy}>Cancel</button>
        </div>
      </form>
    ) : hasPassword && <div className={styles.securityActions}>
      {enabled ? <>
        <button type="button" onClick={() => setMode("regenerate")}>Regenerate backup codes</button>
        <button type="button" onClick={() => setMode("disable")}>Disable</button>
      </> : <button type="button" onClick={() => setMode("setup")}>Set up authenticator</button>}
    </div>}
  </>;
}
