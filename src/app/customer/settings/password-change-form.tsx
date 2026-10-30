"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/auth/client";
import styles from "./settings.module.css";

export function PasswordChangeForm() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    const form = event.currentTarget;
    const values = new FormData(form);
    const newPassword = String(values.get("newPassword") ?? "");
    if (newPassword !== String(values.get("confirmPassword") ?? "")) {
      setError("The new passwords do not match.");
      setBusy(false);
      return;
    }
    try {
      const result = await authClient.changePassword({
        currentPassword: String(values.get("currentPassword") ?? ""),
        newPassword,
        revokeOtherSessions: true,
      });
      if (result.error) {
        setError("Password could not be changed. Check your current password and try again.");
        return;
      }
      form.reset();
      setMessage("Password changed. Other active sessions were signed out.");
    } catch {
      setError("Password could not be changed. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return <form onSubmit={submit} className={styles.passwordForm} aria-busy={busy}>
    <label htmlFor="currentPassword">Current password
      <input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" minLength={16} maxLength={128} required disabled={busy} />
    </label>
    <label htmlFor="newPassword">New password
      <input id="newPassword" name="newPassword" type="password" autoComplete="new-password" minLength={16} maxLength={128} required disabled={busy} />
    </label>
    <label htmlFor="confirmPassword">Confirm new password
      <input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" minLength={16} maxLength={128} required disabled={busy} />
    </label>
    {error && <p role="alert" className={styles.passwordError}>{error}</p>}
    {message && <p role="status" aria-live="polite" className={styles.passwordMessage}>{message}</p>}
    <button type="submit" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
  </form>;
}
