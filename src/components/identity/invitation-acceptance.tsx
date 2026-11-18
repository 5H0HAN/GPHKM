"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useOneTimeLinkFragment } from "./use-one-time-link-fragment";
import styles from "./invitation-acceptance.module.css";

export function InvitationAcceptance() {
  const router = useRouter();
  const [fragment, clearFragment] = useOneTimeLinkFragment();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const token = fragment?.get("token") ?? "";

  async function accept() {
    if (busy) return;
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
      setMessage("Invitation token unavailable. Open the latest invitation email to try again.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/customer/invitations/accept", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const payload = await response.json() as { accepted?: boolean; organizationId?: string };
      if (!response.ok || payload.accepted !== true || !payload.organizationId) {
        setMessage("This invitation could not be accepted. Check that you are signed in with the invited verified email and that the invitation is still valid.");
        return;
      }
      clearFragment();
      setAccepted(true);
      router.replace(`/customer/settings/organization?organizationId=${encodeURIComponent(payload.organizationId)}&updated=invitation`);
      router.refresh();
    } catch {
      setMessage("The invitation could not be accepted right now. Try again from the original invitation email.");
    } finally {
      setBusy(false);
    }
  }

  return <main className={styles.page}>
    <section className={styles.panel} aria-labelledby="invite-title">
      <p className={styles.eyebrow}>ORGANIZATION ACCESS</p>
      <h1 id="invite-title">Accept your invitation</h1>
      <p className={styles.copy}>Sign in with the verified email address that received this invitation. Keep this page open while you sign in in another tab. The server checks the signed-in account against the invitation before accepting it.</p>
      <Link className={styles.link} href="/sign-in" target="_blank" rel="noreferrer">Open sign-in in a new tab</Link>
      <button className={styles.button} type="button" onClick={accept} disabled={busy || accepted}>
        {busy ? "Accepting…" : accepted ? "Invitation accepted" : "Join organization"}
      </button>
      {message && <p role="status" className={styles.note}>{message}</p>}
    </section>
  </main>;
}
