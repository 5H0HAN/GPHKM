"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import styles from "./invitation-acceptance.module.css";

type Kind = "organization" | "staff";

export function InvitationAcceptance({ kind }: { kind: Kind }) {
  const router = useRouter();
  const tokenRef = useRef("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const fromLink = fragment.get("token") ?? "";
    if (fromLink && /^[A-Za-z0-9_-]{40,64}$/.test(fromLink)) {
      tokenRef.current = fromLink;
      window.history.replaceState(null, "", window.location.pathname);
      return;
    }
    tokenRef.current = "";
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  }, [kind]);

  async function accept() {
    if (busy) return;
    const token = tokenRef.current;
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
      setMessage("Invitation token unavailable. Open the latest invitation email to try again.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/${kind === "organization" ? "customer" : "staff"}/invitations/accept`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const payload = await response.json() as { accepted?: boolean; organizationId?: string };
      if (!response.ok || payload.accepted !== true) {
        setMessage("This invitation could not be accepted. Check that you are signed in with the invited verified email and that the invitation is still valid.");
        return;
      }
      tokenRef.current = "";
      setAccepted(true);
      if (kind === "organization" && payload.organizationId) {
        router.replace(`/customer/settings/organization?organizationId=${encodeURIComponent(payload.organizationId)}&updated=invitation`);
      } else {
        setMessage("Staff invitation accepted. A Super Admin must activate access after you verify staff MFA.");
      }
      router.refresh();
    } catch {
      setMessage("The invitation could not be accepted right now. Try again from the original invitation email.");
    } finally {
      setBusy(false);
    }
  }

  const signInHref = kind === "organization" ? "/sign-in" : "/staff/sign-in";

  return <main className={styles.page}>
    <section className={styles.panel} aria-labelledby="invite-title">
      <p className={styles.eyebrow}>{kind === "organization" ? "ORGANIZATION ACCESS" : "STAFF ACCESS"}</p>
      <h1 id="invite-title">Accept your invitation</h1>
      <p className={styles.copy}>Sign in with the verified email address that received this invitation. Keep this page open while you sign in in another tab. The server checks the signed-in account against the invitation before accepting it.</p>
      <Link className={styles.link} href={signInHref} target="_blank" rel="noreferrer">Open sign-in in a new tab</Link>
      <button className={styles.button} type="button" onClick={accept} disabled={busy || accepted}>
        {busy ? "Accepting…" : accepted ? "Invitation accepted" : kind === "organization" ? "Join organization" : "Accept staff invitation"}
      </button>
      {message && <p role="status" className={styles.note}>{message}</p>}
    </section>
  </main>;
}
