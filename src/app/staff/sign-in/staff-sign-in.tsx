"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { staffAuthClient } from "@/auth/staff-client";
import SignInForm from "../../sign-in/sign-in-form";
import styles from "./sign-in.module.css";

export function StaffSignIn({ session, localEnabled, googleEnabled }: {
  session: { email: string; twoFactorEnabled: boolean } | null;
  localEnabled: boolean;
  googleEnabled: boolean;
}) {
  if (session && !session.twoFactorEnabled) return <StaffMfaSetup />;
  if (session) return <>
    <h1>Staff verification required</h1>
    <p className={styles.note}>Use your authenticator to verify this staff session.</p>
    <Link href="/staff/sign-in/verify" className={styles.link}>Continue to verification</Link>
  </>;
  return <SignInForm localEnabled={localEnabled} googleEnabled={googleEnabled} returnTo="/staff" surface="staff" />;
}

function StaffMfaSetup() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ uri: string; backupCodes: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function begin() {
    setBusy(true);
    setError("");
    try {
      const result = await staffAuthClient.twoFactor.enable({ method: "totp", password, issuer: "GPHKM Staff" });
      if (result.error || result.data?.method !== "totp" || !result.data.totpURI || !result.data.backupCodes) {
        setError("Authenticator setup could not start. Check your password and try again.");
        return;
      }
      setSetup({ uri: result.data.totpURI, backupCodes: result.data.backupCodes });
      setPassword("");
    } catch {
      setError("Authenticator setup could not start. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!/^[0-9]{6}$/.test(code)) { setError("Enter the current six-digit authenticator code."); return; }
    setBusy(true);
    setError("");
    try {
      const result = await staffAuthClient.twoFactor.verifyTotp({ code, trustDevice: false });
      if (result.error) { setError("That code could not be verified. Try the current code from your authenticator app."); return; }
      setSetup(null);
      router.replace("/staff");
      router.refresh();
    } catch {
      setError("Verification could not be completed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return <section className={styles.mfa} aria-labelledby="mfa-title">
    <h1 id="mfa-title">Set up staff verification</h1>
    <p className={styles.note}>Staff access requires an authenticator app. Keep your recovery codes somewhere private; they are shown only during setup.</p>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {!setup ? <div className={styles.form}>
      <label htmlFor="staff-password">Confirm your password</label>
      <input id="staff-password" name="staffPassword" type="password" autoComplete="current-password" maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} />
      <button className={styles.primary} type="button" disabled={busy || password.length < 1} onClick={begin}>{busy ? "Preparing…" : "Set up authenticator"}</button>
    </div> : <div className={styles.form}>
      <p>In your authenticator app, add an account using this setup URI:</p>
      <textarea aria-label="Authenticator setup URI" readOnly rows={3} value={setup.uri} />
      <h2>Recovery codes</h2>
      <ul className={styles.codes}>{setup.backupCodes.map((item) => <li key={item}><code>{item}</code></li>)}</ul>
      <label htmlFor="staff-totp-code">Enter the current six-digit code</label>
      <input id="staff-totp-code" name="staffTotpCode" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} />
      <button className={styles.primary} type="button" disabled={busy || code.length !== 6} onClick={verify}>{busy ? "Verifying…" : "Verify and continue"}</button>
    </div>}
  </section>;
}
