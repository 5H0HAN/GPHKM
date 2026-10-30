"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/auth/client";
import styles from "./sign-in.module.css";

export function ResetPasswordForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (!token || token.length > 2048) {
      setError("This reset link is missing or invalid. Request a new one from sign in.");
      setBusy(false);
      return;
    }
    const values = new FormData(event.currentTarget);
    const password = String(values.get("password") ?? "");
    if (password !== String(values.get("confirmation") ?? "")) {
      setError("The passwords do not match.");
      setBusy(false);
      return;
    }
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError("This reset link is invalid or expired. Request a new one and try again.");
        window.history.replaceState(window.history.state, "", window.location.pathname);
        return;
      }
      window.history.replaceState(window.history.state, "", window.location.pathname);
      setComplete(true);
    } catch {
      setError("The password could not be reset. Request a new link and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (complete) return <>
    <h1 id="reset-title">Password updated</h1>
    <p className={styles.description}>Your password has been changed and active sessions have been signed out.</p>
    <a className={styles.link} href="/sign-in">Return to sign in</a>
  </>;

  return <>
    <h1 id="reset-title">Choose a new password</h1>
    <p className={styles.description}>Use the one-time link from your email and choose a unique password with at least 16 characters.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <form className={styles.form} onSubmit={submit} aria-busy={busy}>
      <label htmlFor="password">New password
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={16} maxLength={128} required disabled={busy} />
      </label>
      <label htmlFor="confirmation">Confirm new password
        <input id="confirmation" name="confirmation" type="password" autoComplete="new-password" minLength={16} maxLength={128} required disabled={busy} />
      </label>
      <button className={styles.primary} type="submit" disabled={busy}>{busy ? "Updating…" : "Update password"}</button>
    </form>
  </>;
}
