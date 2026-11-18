"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/auth/client";
import { staffAuthClient } from "@/auth/staff-client";
import { TotpSecretPanel } from "./totp-secret-panel";
import { useStepHeading } from "./use-step-heading";
import styles from "./totp.module.css";

export function TotpEnrollmentForm({ onVerified, onCancel, surface = "customer" }: {
  onVerified: (codes: string[]) => void;
  onCancel?: () => void;
  surface?: "customer" | "staff";
}) {
  const client = surface === "staff" ? staffAuthClient : authClient;
  const [setup, setSetup] = useState<{ uri: string; backupCodes: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const heading = useStepHeading(setup ? "pair" : "password");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError("");
    try {
      if (!setup) {
        const result = await client.twoFactor.enable({
          method: "totp",
          password: String(values.get("currentPassword") ?? ""),
          issuer: surface === "staff" ? "GPHKM Staff" : "GPHKM",
        });
        if (result.error || result.data?.method !== "totp") {
          setError("Authenticator setup could not start. Check your password and try again.");
          return;
        }
        form.reset();
        setSetup({ uri: result.data.totpURI, backupCodes: result.data.backupCodes });
      } else {
        const code = String(values.get("code") ?? "").trim();
        const result = await client.twoFactor.verifyTotp({ code, trustDevice: false });
        if (result.error) {
          setError("That code could not be verified. Enter the current code from your authenticator app.");
          return;
        }
        setSetup(null);
        onVerified(setup.backupCodes);
      }
    } catch {
      setError("Authenticator setup could not be completed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <span role="status">{busy ? setup ? "Verifying authenticator…" : "Preparing authenticator setup…" : ""}</span>
      {setup && <>
        <h4 ref={heading} tabIndex={-1} className={styles.stepHeading}>Pair your authenticator</h4>
        <TotpSecretPanel uri={setup.uri} />
      </>}
      <form className={styles.form} method="post" onSubmit={submit} aria-busy={busy}>
        {setup ? (
          <label key="code">Six-digit authenticator code
            <input name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} spellCheck={false} required disabled={busy} />
          </label>
        ) : (
          <label key="password">Current password
            <input name="currentPassword" type="password" autoComplete="current-password" maxLength={128} required disabled={busy} />
          </label>
        )}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <button type="submit" disabled={busy}>{busy ? "Please wait…" : setup ? "Verify authenticator" : "Set up authenticator"}</button>
          {onCancel && <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>}
        </div>
      </form>
    </>
  );
}
