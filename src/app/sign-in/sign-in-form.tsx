"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { authClient } from "@/auth/client";
import { staffAuthClient } from "@/auth/staff-client";
import { usesStagingReviewNotices, usesStagingTesterNotices, type LegalDocuments } from "@/modules/legal/policy";
import { LegalConsentCheckbox } from "@/components/legal-consent-checkbox";
import { useStepHeading } from "@/components/identity/use-step-heading";
import styles from "./sign-in.module.css";

function signInError(code: string | undefined, fallback: string) {
  switch (code) {
    case "TWO_FACTOR_REQUIRED": return "Sign in with email and password, then verify with your authenticator or a backup code.";
    case "STAFF_IDENTITY_ON_CUSTOMER_SURFACE": return "Use the staff workspace to sign in to this account.";
    case "EMAIL_NOT_VERIFIED": return "Check your email for a verification link before signing in.";
    default: return fallback;
  }
}

export default function SignInForm({ oauthError, session = null, localEnabled, emailPasswordEnabled = false, emailSignupEnabled = false, googleSignupEnabled = false, legalDocuments = null, passwordResetEnabled = false, googleEnabled, legalUnavailable = false, verify = false, returnTo = "/customer", surface = "customer" }: {
  oauthError?: string;
  session?: { email: string } | null;
  localEnabled: boolean;
  emailPasswordEnabled?: boolean;
  emailSignupEnabled?: boolean;
  googleSignupEnabled?: boolean;
  legalDocuments?: LegalDocuments | null;
  passwordResetEnabled?: boolean;
  googleEnabled: boolean;
  legalUnavailable?: boolean;
  verify?: boolean;
  returnTo?: string;
  surface?: "customer" | "staff";
}) {
  const router = useRouter();
  const client = surface === "staff" ? staffAuthClient : authClient;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => oauthError ? signInError(oauthError, emailPasswordEnabled ? "Google sign-in did not finish. Try again or sign in with email and password." : "Google sign-in did not finish. Use your designated test account. New testers must choose Create an account first.") : "");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<"sign-in" | "sign-up" | "reset">("sign-in");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const legalConsentRef = useRef<HTMLInputElement>(null);
  const heading = useStepHeading(verify ? useBackupCode ? "backup-code" : "authenticator-code" : mode);
  const signInPath = surface === "staff" ? "/staff/sign-in" : "/sign-in";
  const showGoogle = surface === "customer" && googleEnabled && !verify && mode !== "reset";

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
          await client.requestPasswordReset({ email: String(values.get("email")).trim() });
        } catch { /* Keep account existence and provider state private. */ }
        setNotice("If the address can receive a password reset link, we’ll send one.");
        return;
      } else if (mode === "sign-up") {
        if (!legalDocuments) {
          setError("Customer registration is temporarily unavailable. Please try again later.");
          return;
        }
        if (!legalConsentRef.current?.checked) {
          setError("Please accept the staging Terms and Privacy drafts before creating your account.");
          legalConsentRef.current?.reportValidity();
          return;
        }
        const password = String(values.get("password"));
        if (password !== String(values.get("confirmPassword"))) {
          setError("Passwords do not match.");
          return;
        }
        const result = await client.$fetch("/sign-up/email", {
          method: "POST",
          body: {
            name: String(values.get("name")).trim(),
            email: String(values.get("email")).trim(),
            password,
            callbackURL: "/customer",
            legalConsent: { accepted: true, termsVersion: legalDocuments.termsVersion, privacyVersion: legalDocuments.privacyVersion },
          },
        });
        if (result.error) {
          setError("Account setup could not be started. Check the details and try again.");
          return;
        }
        form.reset();
        setNotice("If your account is new, check your email for a verification link. If an account already exists, check for sign-in guidance. Sign-in can resend verification for unverified accounts.");
        return;
      } else if (verify) {
        const code = String(values.get("code") ?? "").trim();
        const result = useBackupCode
          ? await client.twoFactor.verifyBackupCode({ code, trustDevice: false })
          : await client.twoFactor.verifyTotp({ code, trustDevice: false });
        if (result.error) {
          setError(useBackupCode
            ? "That backup code could not be verified. Use an unused code or sign in again."
            : "That code could not be verified. Use the current code or sign in again.");
          return;
        }
      } else {
        const result = await client.signIn.email({
          email: String(values.get("email")).trim(),
          password: String(values.get("password")),
          rememberMe: false,
        });
        if (result.error) {
          setError(signInError(result.error.code, "Sign-in failed. Check your details and try again."));
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
    if (!showGoogle || busy) return;
    const signingUp = mode === "sign-up";
    if (signingUp && (!googleSignupEnabled || !legalDocuments)) return;
    if (signingUp && !legalConsentRef.current?.checked) {
      setError("Please accept the staging Terms and Privacy drafts before creating your account.");
      legalConsentRef.current?.reportValidity();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signIn.social({
        provider: "google", callbackURL: returnTo, errorCallbackURL: "/sign-in", requestSignUp: signingUp,
        ...(signingUp && legalDocuments ? { additionalData: { legalConsent: { accepted: true, termsVersion: legalDocuments.termsVersion, privacyVersion: legalDocuments.privacyVersion } } } : {}),
      });
      if (result.error) setError(signInError(result.error.code, "Google sign-in could not start. Try again."));
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
        router.replace(signInPath);
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
      <h1 ref={heading} tabIndex={-1}>{session ? "You’re signed in" : verify ? useBackupCode ? "Verify with a backup code" : "Verify your sign-in" : mode === "sign-up" ? "Create your account" : mode === "reset" ? "Reset your password" : "Sign in to GPHKM"}</h1>
      <p className={styles.description}>
        {session ? `Signed in as ${session.email}.` : verify
          ? useBackupCode ? "Enter one of the backup codes you saved when you set up your authenticator." : "Enter the six-digit code from your authenticator app."
          : mode === "reset" ? "Enter your account email. If it can use a password, we’ll send a secure reset link."
            : mode === "sign-up" && usesStagingTesterNotices(legalDocuments) ? "Review the staging tester notices, then continue with your designated Google account."
            : mode === "sign-up" && usesStagingReviewNotices(legalDocuments) ? "Create your staging customer account with verified email or Google. Review the staging Terms and Privacy drafts before continuing."
            : mode === "sign-up" ? `Create your customer account with ${emailSignupEnabled && googleSignupEnabled ? "verified email or Google" : emailSignupEnabled ? "verified email" : "Google"}. Accept the current Terms and Privacy Policy to continue.`
            : googleEnabled
            ? emailPasswordEnabled ? "Sign in with Google or your verified email address." : "Use your designated Google test account to continue."
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
          {mode === "sign-up" && legalDocuments ? <LegalConsentCheckbox documents={legalDocuments} disabled={busy} inputRef={legalConsentRef} form={emailSignupEnabled ? "customer-signup-form" : undefined} onInvalid={() => setError("Please accept the staging Terms and Privacy drafts before creating your account.")} /> : null}
          {showGoogle && (mode !== "sign-up" || googleSignupEnabled) ? <button className={styles.secondary} type="button" disabled={busy} onClick={google}>
            {busy ? "Please wait…" : mode === "sign-up" ? "Create account with Google" : "Continue with Google"}
          </button> : null}
          {verify || (mode === "sign-up" ? emailSignupEnabled : localEnabled || emailPasswordEnabled) ? (
            <form id={mode === "sign-up" ? "customer-signup-form" : undefined} method="post" onSubmit={submit} className={styles.form} aria-busy={busy}>
              {verify ? (
                <label htmlFor="code">{useBackupCode ? "Backup code" : "Authenticator code"}
                  <input key={useBackupCode ? "backup" : "totp"} id="code" name="code" type="text" autoComplete="one-time-code"
                    inputMode={useBackupCode ? "text" : "numeric"} pattern={useBackupCode ? undefined : "[0-9]{6}"}
                    maxLength={useBackupCode ? 64 : 6} spellCheck={false} required disabled={busy} />
                </label>
              ) : (
                <>
                  {localEnabled && <p className={styles.localNotice}>Local development sign-in</p>}
                  {mode === "sign-up" && <label htmlFor="name">Your name
                    <input id="name" name="name" type="text" autoComplete="name" maxLength={100} required disabled={busy} />
                  </label>}
                  <label htmlFor="email">Email
                    <input id="email" name="email" type="email" autoComplete="email" spellCheck={false} required maxLength={254} disabled={busy} />
                  </label>
                  {mode !== "reset" && <label htmlFor="password">{mode === "sign-up" ? "Create password" : "Password"}
                    <input id="password" name="password" type="password" autoComplete={mode === "sign-up" ? "new-password" : "current-password"} required minLength={mode === "sign-up" ? 16 : undefined} maxLength={128} disabled={busy} />
                  </label>}
                  {mode === "sign-up" && <label htmlFor="confirmPassword">Confirm password
                    <input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required minLength={16} maxLength={128} disabled={busy} />
                  </label>}
                </>
              )}
              <button className={styles.primary} type="submit" disabled={busy}>
                {busy ? "Please wait…" : verify ? "Verify code" : mode === "sign-up" ? "Create account" : mode === "reset" ? "Send reset link" : "Sign in"}
              </button>
            </form>
          ) : !googleEnabled ? <p>Sign-in is currently unavailable.</p> : null}
          {verify && <div className={styles.authLinks}>
            <button type="button" className={styles.textButton} disabled={busy} onClick={() => { setUseBackupCode(!useBackupCode); setError(""); }}>
              {useBackupCode ? "Use an authenticator code" : "Use a backup code"}
            </button>
            <Link href={signInPath} className={styles.authLink}>Back to sign in</Link>
          </div>}
          {notice && <p className={styles.success} role="status" aria-live="polite">{notice}</p>}
          {!verify && (emailPasswordEnabled || googleSignupEnabled) && <div className={styles.authLinks}>
            {mode === "sign-in" && emailPasswordEnabled && passwordResetEnabled && <button type="button" className={styles.textButton} disabled={busy} onClick={() => { setMode("reset"); setError(""); setNotice(""); }}>Forgot password?</button>}
            {mode === "sign-in" && emailPasswordEnabled && !passwordResetEnabled && <p className={styles.localNotice} role="status">Password reset email is not configured.</p>}
            {mode === "sign-in" && surface === "customer" && (emailSignupEnabled || googleSignupEnabled) && <button type="button" className={styles.textButton} disabled={busy} onClick={() => { setMode("sign-up"); setError(""); setNotice(""); }}>Create an account</button>}
            {mode !== "sign-in" && <button type="button" className={styles.textButton} disabled={busy} onClick={() => { setMode("sign-in"); setError(""); setNotice(""); }}>Back to sign in</button>}
          </div>}
        </>
      )}
    </>
  );
}
