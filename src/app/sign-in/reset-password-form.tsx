"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { authClient } from "@/auth/client";
import { staffAuthClient } from "@/auth/staff-client";
import { useOneTimeLinkFragment } from "@/components/identity/use-one-time-link-fragment";
import { useStepHeading } from "@/components/identity/use-step-heading";
import styles from "./sign-in.module.css";

const UNAVAILABLE_LINK = "This reset link is missing, invalid, or expired. Request a new link from sign in.";

export function ResetPasswordForm({ surface }: { surface: "customer" | "staff" }) {
  const [fragment, clearFragment] = useOneTimeLinkFragment();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);
  const signInPath = surface === "staff" ? "/staff/sign-in" : "/sign-in";
  const token = fragment?.get("token") ?? "";
  const tokenAvailable = /^[A-Za-z0-9_-]{16,128}$/.test(token);
  const heading = useStepHeading(complete ? "complete" : error === UNAVAILABLE_LINK ? "unavailable" : "reset");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !tokenAvailable) return;
    setError("");
    const form = event.currentTarget;
    const values = new FormData(form);
    const password = String(values.get("password") ?? "");
    if (password !== String(values.get("confirmation") ?? "")) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const result = surface === "staff"
        ? await staffAuthClient.resetPassword({ newPassword: password, token })
        : await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        if (result.error.code === "INVALID_TOKEN") {
          clearFragment();
          setError(UNAVAILABLE_LINK);
          return;
        }
        setError("The password could not be reset. Try again or request a new link.");
        return;
      }
      form.reset();
      clearFragment();
      setComplete(true);
    } catch {
      setError("The password could not be reset. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const status = complete ? "Password reset. Sign in with your new password."
    : fragment === null ? "Checking the reset link…"
    : !tokenAvailable ? UNAVAILABLE_LINK : "";
  return <>
    <h1 ref={heading} tabIndex={-1}>
      {complete ? "Password reset" : fragment !== null && !tokenAvailable ? "Reset link unavailable" : "Choose a new password"}
    </h1>
    <div role="status">{status && <p className={styles.description}>{status}</p>}</div>
    {!complete && tokenAvailable && <>
      <p className={styles.description}>Choose a unique password with at least 16 characters.</p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <form className={styles.form} method="post" onSubmit={submit} aria-busy={busy}>
        <label htmlFor="password">New password
          <input id="password" name="password" type="password" autoComplete="new-password" minLength={16} maxLength={128} required disabled={busy} />
        </label>
        <label htmlFor="confirmation">Confirm new password
          <input id="confirmation" name="confirmation" type="password" autoComplete="new-password" minLength={16} maxLength={128} required disabled={busy} />
        </label>
        <button className={styles.primary} type="submit" disabled={busy}>{busy ? "Updating…" : "Update password"}</button>
      </form>
    </>}
    <Link className={styles.link} href={signInPath}>{complete ? "Return to sign in" : "Back to sign in"}</Link>
  </>;
}
