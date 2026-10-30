"use client";

import { useEffect, useState, type FormEvent } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { CheckoutElementsProvider, PaymentElement, useCheckoutElements } from "@stripe/react-stripe-js/checkout";
import styles from "./topup-checkout.module.css";
import customerStyles from "../../customer.module.css";

type Session = { clientSecret: string; publishableKey: string; attemptId: string; amountMinor: string };

function PaymentForm({ onSubmitted }: { onSubmitted: () => void }) {
  const result = useCheckoutElements();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (result.type === "loading") return <p role="status" aria-live="polite" className={customerStyles.panelText}>Loading secure payment form…</p>;
  if (result.type === "error") return <p role="alert" className={styles.error}>Secure checkout could not be loaded. Please try again later.</p>;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (result.type !== "success" || !result.checkout.canConfirm) return;
    setPending(true);
    setError("");
    try {
      const confirmed = await result.checkout.confirm({ returnUrl: `${window.location.origin}/customer/wallet/recharge` });
      if (confirmed.type === "error") setError(confirmed.error.message);
      else onSubmitted();
    } catch {
      setError("Payment could not be confirmed. Check your wallet before trying again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className={styles.form}>
      <PaymentElement />
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <button className={styles.button} type="submit" disabled={!result.checkout.canConfirm || pending}>
        {pending ? "Confirming…" : "Continue securely"}
      </button>
    </form>
  );
}

export function TopUpCheckout({ organizationId, returnedFromProvider, checkoutAvailable }: { organizationId: string; returnedFromProvider: boolean; checkoutAvailable: boolean }) {
  const [amount, setAmount] = useState("50.00");
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(returnedFromProvider);
  const [retryPending, setRetryPending] = useState(false);
  const [error, setError] = useState("");
  const storageKey = `gphkm.wallet.topup.${organizationId}`;

  useEffect(() => {
    if (returnedFromProvider) sessionStorage.removeItem(storageKey);
  }, [returnedFromProvider, storageKey]);

  async function begin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    let idempotencyKey: string;
    let submittedAmount = amount;
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as { key?: unknown; amount?: unknown };
        if (typeof parsed.key !== "string" || typeof parsed.amount !== "string") throw new Error("Invalid saved attempt");
        idempotencyKey = parsed.key;
        submittedAmount = parsed.amount;
        setAmount(parsed.amount);
      } else {
        idempotencyKey = crypto.randomUUID();
        sessionStorage.setItem(storageKey, JSON.stringify({ key: idempotencyKey, amount: submittedAmount }));
      }
    } catch {
      setBusy(false);
      setError("Secure checkout storage is unavailable in this browser.");
      return;
    }
    setRetryPending(true);
    try {
      const response = await fetch("/api/customer/wallet/top-ups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, amount: submittedAmount, idempotencyKey }),
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        if (response.status === 400 || response.status === 403 || response.status === 503) {
          sessionStorage.removeItem(storageKey);
          setRetryPending(false);
        }
        throw new Error(typeof body.error === "string" ? body.error : "Wallet funding is temporarily unavailable.");
      }
      if (typeof body.checkoutSessionClientSecret !== "string" || typeof body.publishableKey !== "string"
        || typeof body.paymentAttemptId !== "string" || typeof body.amountMinor !== "string") {
        throw new Error("Secure checkout is temporarily unavailable.");
      }
      setSession({ clientSecret: body.checkoutSessionClientSecret, publishableKey: body.publishableKey,
        attemptId: body.paymentAttemptId, amountMinor: body.amountMinor });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet funding is temporarily unavailable.");
    } finally {
      setBusy(false);
    }
  }

  if (submitted) return <p role="status" aria-live="polite" aria-atomic="true" className={customerStyles.panelText}>Payment confirmation is being checked. Your wallet changes only after Stripe sends a verified confirmation. Refresh the wallet in a moment to see the result.</p>;
  if (!checkoutAvailable) return <p className={customerStyles.panelText}>Wallet funding is temporarily unavailable while payment configuration and launch checks are completed. Your existing wallet and orders remain available.</p>;

  return (
    <div className={styles.form}>
      {!session ? (
        <form onSubmit={begin} className={styles.form}>
          <label className={styles.fieldLabel} htmlFor="topup-amount">Amount (USD)</label>
          <input id="topup-amount" className={styles.amountInput} type="number" inputMode="decimal" autoComplete="off" min="0.01" step="0.01"
            value={amount} onChange={(event) => setAmount(event.target.value)} disabled={retryPending} required />
          <p className={customerStyles.panelText}>A single settled top-up of at least {"$"}50 qualifies for marketplace access under the current six-month policy.</p>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <button className={styles.button} type="submit" disabled={busy}>{busy ? "Preparing secure checkout…" : retryPending ? "Retry secure checkout" : "Continue to payment"}</button>
        </form>
      ) : (
        <>
          <p className={customerStyles.panelText}>Top-up attempt {session.attemptId.slice(0, 8)} · {"$"}{(Number(session.amountMinor) / 100).toFixed(2)} USD</p>
          <CheckoutElementsProvider stripe={loadStripe(session.publishableKey)} options={{ clientSecret: session.clientSecret }}>
            <PaymentForm onSubmitted={() => { sessionStorage.removeItem(storageKey); setSubmitted(true); }} />
          </CheckoutElementsProvider>
        </>
      )}
    </div>
  );
}
