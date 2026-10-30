"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { createSupplierAction } from "./actions";
import styles from "./suppliers.module.css";

function SaveButton() {
  const { pending } = useFormStatus();
  return <button className={styles.saveAction} type="submit" disabled={pending}>
    {pending ? "Saving…" : "Save supplier"}
  </button>;
}

export function AddSupplierDialog({ error, created }: { error?: string; created: boolean }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(Boolean(error));
  const [showSuccess, setShowSuccess] = useState(created);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!showSuccess) return;
    const timeout = window.setTimeout(() => setShowSuccess(false), 4500);
    return () => window.clearTimeout(timeout);
  }, [showSuccess]);

  return <>
    <button className={styles.addSupplierButton} type="button" onClick={() => setOpen(true)}>
      <span aria-hidden="true">＋</span> Add supplier
    </button>

    <dialog
      ref={dialogRef}
      className={styles.supplierDialog}
      aria-labelledby="add-supplier-title"
      aria-describedby="add-supplier-description"
      onCancel={() => setOpen(false)}
      onClose={() => setOpen(false)}
      onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
    >
      <div className={styles.dialogHeader}>
        <div>
          <p className={styles.eyebrow}>Supplier directory</p>
          <h2 id="add-supplier-title">Add a supplier</h2>
          <p id="add-supplier-description">Save a private contact record before importing inventory.</p>
        </div>
        <button className={styles.dialogClose} type="button" aria-label="Close dialog" onClick={() => setOpen(false)}>×</button>
      </div>

      {error && <p className={styles.error} role="alert">Supplier could not be saved. Check the required details and your staff access, then try again.</p>}
      <form action={createSupplierAction} className={styles.supplierForm}>
        <label>Supplier name<input name="name" required maxLength={160} autoComplete="organization" autoFocus /></label>
        <label>Primary contact<input name="contactName" required maxLength={160} autoComplete="name" /></label>
        <label>Contact email<input name="email" type="email" required maxLength={320} autoComplete="email" /></label>
        <p className={styles.privateNote}>Contact details stay in the staff workspace and are not shown in the marketplace.</p>
        <div className={styles.dialogActions}>
          <button className={styles.cancelAction} type="button" onClick={() => setOpen(false)}>Cancel</button>
          <SaveButton />
        </div>
      </form>
    </dialog>

    {showSuccess && <p className={styles.successToast} role="status">
      <span className={styles.successIcon} aria-hidden="true">✓</span> Supplier saved
    </p>}
  </>;
}
