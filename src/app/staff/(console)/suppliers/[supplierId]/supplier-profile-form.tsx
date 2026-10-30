"use client";

import { useState, useTransition, type FormEvent } from "react";
import { updateSupplierProfileAction } from "../actions";
import styles from "../../catalog/catalog.module.css";

type Props = { id: string; name: string; status: "ACTIVE" | "INACTIVE"; notes: string | null };

const errors = {
  invalid: "Check the supplier details and try again.",
  session: "Your staff session expired. Sign in again before saving.",
  permission: "Your staff account does not have permission to manage suppliers.",
  save: "The supplier could not be saved. Try again.",
} as const;

export function SupplierProfileForm({ id, name, status, notes }: Props) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: true } | { ok: false; reason: keyof typeof errors } | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setResult(null);
    startTransition(async () => setResult(await updateSupplierProfileAction(form)));
  }

  return <form onSubmit={submit} className={styles.listingForm} aria-busy={pending}>
    <input type="hidden" name="supplierId" value={id} />
    <div className={styles.formGrid}>
      <label>Supplier name<input name="name" required maxLength={160} defaultValue={name} /></label>
      <label>Status<select name="status" defaultValue={status}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label>
    </div>
    <p className={styles.hint}>Changing supplier status does not automatically pause or reprice linked listings.</p>
    <label>Internal notes<textarea name="notes" rows={4} maxLength={4000} defaultValue={notes ?? ""} /></label>
    <button className={styles.button} type="submit" disabled={pending}>{pending ? "Saving…" : "Save supplier"}</button>
    {result?.ok && <p className={styles.success} role="status"><span aria-hidden="true">✓ </span>Supplier saved.</p>}
    {result && !result.ok && <p className={styles.error} role="alert">{errors[result.reason]}</p>}
  </form>;
}
