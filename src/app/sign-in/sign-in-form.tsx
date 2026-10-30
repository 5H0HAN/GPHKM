"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/auth/client";
import { staffAuthClient } from "@/auth/staff-client";
import styles from "./sign-in.module.css";

export default function SignInForm({ session = null, localEnabled, emailPasswordEnabled = false, emailSignupEnabled = false, passwordResetEnabled = false, localMfaDisabled = false, googleEnabled, legalUnavailable = false, verify = false, returnTo = "/customer", surface = "customer" }: {
  session?: { email: string; twoFactorEnabled: boolean } | null;
  localEnabled: boolean;
  emailPasswordEnabled?: boolean;
  emailSignupEnabled?: boolean;
  passwordResetEnabled?: boolean;
  localMfaDisabled?: boolean;
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
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<"sign-in" | "sign-up" | "reset">("sign-in");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      if (mode === "reset") {
        try {
          await client.requestPasswordReset({ email: String(values.get("email")).trim(), redirectTo: `${window.location.origin}/sign-in/reset-password` });
        } catch { /* Keep account existence and provider state private. */ }
        setNotice("If an account can use email and password, a reset link will be sent to that address.");
        return;
      } else if (mode === "sign-up") {
        const result = await client.signUp.email({
          name: String(values.get("name")).trim(),
          email: String(values.get("email")).trim(),
          password: String(values.get("password")),
          callbackURL: "/customer",
        });
        if (result.error) {
          setError("Account setup could not be started. Check the details and try again.");
          return;
        }
        form.reset();
        setNotice("Check your email for a verification link. After verifying, you’ll accept the current Terms and Privacy Policy before entering your workspace.");
        return;
      } else if (verify) {
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
      const callbackURL = surface === "staff" && !localMfaDisabled ? "/staff/sign-in" : returnTo;
      const result = await client.signIn.social({ provider: "google", callbackURL });
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
      <h1>{session ? "You’re signed in" : verify ? "Verify your sign-in" : mode === "sign-up" ? "Create your account" : mode === "reset" ? "Reset your password" : "Sign in to GPHKM"}</h1>
      <p className={styles.description}>
        {session ? `Signed in as ${session.email}.` : verify
          ? "Enter the six-digit code from your authenticator app."
          : mode === "reset" ? "Enter your account email. If it can use a password, we’ll send a secure reset link."
            : mode === "sign-up" ? "Create your account with a verified email address. You’ll review the current Terms and Privacy Policy during workspace setup."
            : googleEnabled
            ? "Continue with Google to sign in or create a verified customer account. New customers review and accept the current Terms and Privacy Policy during organization setup."
            : "Access your placement workspace."}
      </p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {legalUnavailable && !session && <p className={styles.error} role="status">Customer registration is temporarily unavailable. Please try again later.</p>}
      {session ? (
        <>
          <Link href={returnTo} className={styles.link}>Open your workspace</Link>
          <button className={styles.secondary} type="button" disabled={busy} onClick={signOut}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </>
      ) : (
        <>
          {googleEnabled ? <button className={styles.secondary} type="button" disabled={busy} onClick={google}>
            {busy ? "Please wait…" : "Continue with Google"}
          </button> : null}
          {verify || localEnabled || emailPasswordEnabled ? (
            <form onSubmit={submit} className={styles.form} aria-busy={busy}>
              {verify ? (
                <label htmlFor="code">Authenticator code
                  <input id="code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code"
                    pattern="[0-9]{6}" minLength={6} maxLength={6} required autoFocus disabled={busy} />
                </label>
              ) : (
                <>
                  {localEnabled && <p className={styles.localNotice}>Local development sign-in</p>}
                  {mode === "sign-up" && <label htmlFor="name">Your name
                    <input id="name" name="name" type="text" autoComplete="name" maxLength={100} required disabled={busy} />
                  </label>}
                  <label htmlFor="email">Email
                    <input id="email" name="email" type="email" autoComplete="email" required maxLength={254} disabled={busy} />
                  </label>
                  {mode !== "reset" && <label htmlFor="password">{mode === "sign-up" ? "Create password" : "Password"}
                    <input id="password" name="password" type="password" autoComplete={mode === "sign-up" ? "new-password" : "current-password"} required minLength={16} maxLength={128} disabled={busy} />
                  </label>}
                </>
              )}
              <button className={styles.primary} type="submit" disabled={busy}>
                {busy ? "Please wait…" : verify ? "Verify code" : mode === "sign-up" ? "Create account" : mode === "reset" ? "Send reset link" : "Sign in"}
              </button>
            </form>
          ) : !googleEnabled ? <p>Sign-in is currently unavailable.</p> : null}
          {verify ? <Link href="/sign-in" className={styles.link}>Back to sign in</Link> : null}
          {notice && <p className={styles.success} role="status" aria-live="polite">{notice}</p>}
          {!verify && surface === "customer" && emailPasswordEnabled && <div className={styles.authLinks}>
            {mode === "sign-in" && <button type="button" className={styles.textButton} disabled={!passwordResetEnabled} onClick={() => { setMode("reset"); setError(""); setNotice(""); }}>Forgot password?</button>}
            {mode === "sign-in" && !passwordResetEnabled && <p className={styles.localNotice} role="status">Password reset email is not configured in this environment.</p>}
            {mode === "sign-in" && emailSignupEnabled && <button type="button" className={styles.textButton} onClick={() => { setMode("sign-up"); setError(""); setNotice(""); }}>Create an account</button>}
            {mode !== "sign-in" && <button type="button" className={styles.textButton} onClick={() => { setMode("sign-in"); setError(""); setNotice(""); }}>Back to sign in</button>}
          </div>}
        </>
      )}
    </>
  );
}
