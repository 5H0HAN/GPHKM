"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/auth/client";
import { staffAuthClient } from "@/auth/staff-client";
import styles from "./sign-in.module.css";

export default function SignInForm({ session = null, localEnabled, googleEnabled, legalUnavailable = false, verify = false, returnTo = "/sign-in", surface = "customer" }: {
  session?: { email: string; twoFactorEnabled: boolean } | null;
  localEnabled: boolean;
  googleEnabled: boolean;
  legalUnavailable?: boolean;
  verify?: boolean;
  returnTo?: string;
  surface?: "customer" | "staff";
}) {
  const router = useRouter();
  const client = surface === "staff" ? staffAuthClient : authClient;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      if (verify) {
        const result = await client.twoFactor.verifyTotp({ code: String(values.get("code")), trustDevice: false });
        if (result.error) {
          setError("The code could not be verified. Try a new code, or sign in again.");
          return;
        }
      } else {
        const result = await client.signIn.email({
          email: String(values.get("email")).trim(),
          password: String(values.get("password")),
          rememberMe: false,
        });
        if (result.error) {
          setError("Sign-in failed. Check your details and try again.");
          return;
        }
        if (result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect) return;
      }
      form.reset();
      router.replace(returnTo);
      router.refresh();
    } catch {
      setError("Unable to connect. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setBusy(true);
    setError("");
    try {
      const result = await client.signIn.social({ provider: "google", callbackURL: surface === "staff" ? "/staff/sign-in" : "/sign-in" });
      if (result.error) setError("Google sign-in could not start. Please try again.");
    } catch {
      setError("Unable to connect. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError("");
    try {
      const result = await client.signOut();
      if (result.error) setError("Sign-out failed. Please try again.");
      else {
        router.replace("/sign-in");
        router.refresh();
      }
    } catch {
      setError("Unable to connect. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>{session ? "You’re signed in" : verify ? "Verify your sign-in" : "Sign in to GPHKM"}</h1>
      <p className={styles.description}>
        {session ? `Signed in as ${session.email}.` : verify
          ? "Enter the six-digit code from your authenticator app."
          : googleEnabled
            ? "Continue with Google to sign in or create a verified customer account. New customers review and accept the current Terms and Privacy Policy during organization setup."
            : "Access your placement workspace."}
      </p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {legalUnavailable && !session && <p className={styles.error} role="status">Customer registration is temporarily unavailable. Please try again later.</p>}
      {session ? (
        <>
          <Link href="/" className={styles.link}>Return to workspace</Link>
          <button className={styles.secondary} type="button" disabled={busy} onClick={signOut}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </>
      ) : (
        <>
          {googleEnabled ? <button className={styles.secondary} type="button" disabled={busy} onClick={google}>
            {busy ? "Please wait…" : "Continue with Google"}
          </button> : null}
          {verify || localEnabled ? (
            <form onSubmit={submit} className={styles.form} aria-busy={busy}>
              {verify ? (
                <label htmlFor="code">Authenticator code
                  <input id="code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code"
                    pattern="[0-9]{6}" minLength={6} maxLength={6} required autoFocus disabled={busy} />
                </label>
              ) : (
                <>
                  <p className={styles.localNotice}>Local development sign-in</p>
                  <label htmlFor="email">Email
                    <input id="email" name="email" type="email" autoComplete="username" required maxLength={254} disabled={busy} />
                  </label>
                  <label htmlFor="password">Password
                    <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={128} disabled={busy} />
                  </label>
                </>
              )}
              <button className={styles.primary} type="submit" disabled={busy}>
                {busy ? "Please wait…" : verify ? "Verify code" : "Sign in"}
              </button>
            </form>
          ) : !googleEnabled ? <p>Sign-in is currently unavailable.</p> : null}
          {verify ? <Link href="/sign-in" className={styles.link}>Back to sign in</Link> : null}
        </>
      )}
    </>
  );
}
