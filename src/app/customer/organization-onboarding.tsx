"use client";

import { useState } from "react";
import styles from "./customer.module.css";
import type { LegalDocuments } from "@/modules/legal/policy";
import { LegalConsentCheckbox } from "@/components/legal-consent-checkbox";

export function OrganizationOnboarding({ documents }: { documents: LegalDocuments }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/customer/onboarding/organization", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name, accepted: values.get("accepted") === "on", termsVersion: documents.termsVersion, privacyVersion: documents.privacyVersion }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error ?? "We could not set up your organization.");
      }
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "We could not set up your organization.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.panel}>
      <h1 className={styles.title}>Set up your organization</h1>
      <p className={styles.subtitle}>Your organization keeps your team, wallet, and orders together.</p>
      <form onSubmit={submit}>
        <label className={styles.panelText} htmlFor="organization-name">Organization name</label>
        <input id="organization-name" name="organizationName" className={styles.textInput} autoComplete="organization" minLength={2} maxLength={120} required value={name} onChange={(event) => setName(event.target.value)} />
        <LegalConsentCheckbox documents={documents} disabled={busy} />
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <button className={styles.panelAction} type="submit" disabled={busy}>{busy ? "Setting up…" : "Continue"}</button>
      </form>
    </section>
  );
}
