"use client";
import { useState } from "react";
import type { LegalDocuments } from "@/modules/legal/policy";
import { LegalConsentCheckbox } from "@/components/legal-consent-checkbox";
import styles from "./customer.module.css";

export function CustomerLegalAcceptance({ documents }: { documents: LegalDocuments }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function accept(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/customer/legal-consent", { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ accepted: values.get("accepted") === "on", termsVersion: documents.termsVersion, privacyVersion: documents.privacyVersion }) });
      if (!response.ok) throw new Error("Read and accept the current documents before continuing. Refresh if the versions have changed.");
      window.location.reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Acceptance could not be saved. Try again."); }
    finally { setBusy(false); }
  }
  return <section className={styles.panel}>
    <h1 className={styles.title}>Review the current documents</h1>
    <p className={styles.subtitle}>Accept the current Terms and Privacy Policy before protected organization actions such as placing orders or adding funds. You can still use account settings and view your acceptance history. Newsletter preferences remain separate.</p>
    <form onSubmit={accept} aria-busy={busy}><LegalConsentCheckbox documents={documents} disabled={busy} />
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button className={styles.panelAction} type="submit" disabled={busy}>{busy ? "Saving…" : "Accept and continue"}</button>
    </form>
  </section>;
}
