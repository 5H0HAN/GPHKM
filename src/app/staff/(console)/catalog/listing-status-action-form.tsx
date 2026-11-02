"use client";

import { createContext, use, useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ListingStatus } from "@/modules/catalog/domain";
import type { ListingStatusActionState } from "./listing-status-action-state";
import type { transitionListingAction } from "./actions";
import styles from "./catalog.module.css";

const initialState: ListingStatusActionState = { result: null, message: "" };
type StatusFormAction = (formData: FormData) => void | Promise<void>;
type ListingStatusActionContextValue = { formAction: StatusFormAction };
const ListingStatusActionContext = createContext<ListingStatusActionContextValue | null>(null);

export function ListingStatusFeedback({ action, children }: { action: typeof transitionListingAction; children: ReactNode }) {
  const [state, formAction] = useActionState(action, initialState);
  return <ListingStatusActionContext value={{ formAction }}>
    {state.message && <p role={state.result === "error" ? "alert" : "status"} className={state.result === "error" ? styles.error : styles.success}>{state.message}</p>}
    {children}
  </ListingStatusActionContext>;
}

function ListingStatusSubmitButton({ label, listingTitle, nextStatus, primary }: {
  label: string;
  listingTitle: string;
  nextStatus: ListingStatus;
  primary: boolean;
}) {
  const { pending } = useFormStatus();
  return <button disabled={pending} className={primary ? styles.primaryAction : nextStatus === "ARCHIVED" ? styles.archiveAction : styles.secondaryAction} type="submit" aria-label={`${label} ${listingTitle}`}>
    {label}
  </button>;
}

export function ListingStatusActionForm({
  listingId,
  listingTitle,
  nextStatus,
  label,
  primary,
}: {
  listingId: string;
  listingTitle: string;
  nextStatus: ListingStatus;
  label: string;
  primary: boolean;
}) {
  const statusAction = use(ListingStatusActionContext);
  if (!statusAction) throw new Error("ListingStatusActionForm must be inside ListingStatusFeedback");
  return <form
    action={statusAction.formAction}
    className={styles.actionForm}
    onSubmit={(event) => {
      if (nextStatus === "ARCHIVED" && !window.confirm(`Archive “${listingTitle}”? It will leave the active catalog. This status change is recorded.`)) {
        event.preventDefault();
      }
    }}
  >
    <input type="hidden" name="id" value={listingId} />
    <input type="hidden" name="status" value={nextStatus} />
    <ListingStatusSubmitButton label={label} listingTitle={listingTitle} nextStatus={nextStatus} primary={primary} />
  </form>;
}
