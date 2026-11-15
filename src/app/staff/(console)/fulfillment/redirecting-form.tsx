"use client";

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { isSafeStaffNavigationTarget } from "./navigation";
import styles from "./fulfillment.module.css";

type RedirectingAction = (formData: FormData) => Promise<{ redirectTo: string }>;

export function RedirectingForm({ action, children, className }: {
  action: RedirectingAction;
  children: ReactNode;
  className?: string;
}) {
  const submittingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(formData: FormData) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setPending(true);
    setFailed(false);
    try {
      const result = await action(formData);
      if (!isSafeStaffNavigationTarget(result.redirectTo)) throw new Error("Invalid staff navigation target");
      window.location.assign(result.redirectTo);
    } catch {
      submittingRef.current = false;
      setPending(false);
      setFailed(true);
    }
  }

  return <form action={submit} className={className} aria-busy={pending}>
    {children}
    {pending && <p className={styles.help} role="status">Saving. Please wait…</p>}
    {failed && <p className={styles.error} role="alert">We couldn’t confirm the result. Your action may already have completed. Reload and check the current state before submitting again.</p>}
  </form>;
}
