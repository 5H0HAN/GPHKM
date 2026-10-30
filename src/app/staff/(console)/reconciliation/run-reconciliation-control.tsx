"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { runFinanceReconciliationAction } from "./finance-actions";
import styles from "../reconciliation.module.css";

const initialState = { status: "idle" } as const;

export function RunReconciliationControl() {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(runFinanceReconciliationAction, initialState);

  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state]);

  return <div className={styles.runControl}>
    <form action={formAction}>
      <button type="submit" disabled={pending}>{pending ? "Running reconciliation…" : "Run reconciliation"}</button>
    </form>
    {state.status === "success" && <p role="status" className={styles.runStatus}>Reconciliation finished. The latest findings are shown below.</p>}
    {state.status === "error" && <div role="alert" className={`${styles.runStatus} ${styles.runError}`}><p>{state.message}</p>{state.reason === "session" && <Link href="/staff/sign-in">Go to staff sign-in</Link>}</div>}
  </div>;
}
