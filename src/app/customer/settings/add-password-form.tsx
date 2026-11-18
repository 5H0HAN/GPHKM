"use client";

import { useActionState } from "react";
import { addCustomerPasswordAction } from "./actions";
import styles from "./settings.module.css";

export function AddPasswordForm({ organizationId }: { organizationId: string | null }) {
  const [state, action, pending] = useActionState(addCustomerPasswordAction, { error: "" });
  return (
    <form action={action} className={styles.passwordForm} aria-busy={pending}>
      <input type="hidden" name="organizationId" value={organizationId ?? ""} />
      <label>New password
        <input name="newPassword" type="password" autoComplete="new-password" minLength={16} maxLength={128} required disabled={pending} />
      </label>
      <label>Confirm new password
        <input name="confirmPassword" type="password" autoComplete="new-password" minLength={16} maxLength={128} required disabled={pending} />
      </label>
      {state.error && <p role="alert" className={styles.passwordError}>{state.error}</p>}
      <button type="submit" disabled={pending}>{pending ? "Saving…" : "Add password"}</button>
    </form>
  );
}
