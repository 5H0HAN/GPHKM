"use client";

import type { ListingStatus } from "@/modules/catalog/domain";
import type { transitionListingAction } from "./actions";
import styles from "./catalog.module.css";

export function ListingStatusActionForm({
  action,
  listingId,
  listingTitle,
  nextStatus,
  label,
  primary,
}: {
  action: typeof transitionListingAction;
  listingId: string;
  listingTitle: string;
  nextStatus: ListingStatus;
  label: string;
  primary: boolean;
}) {
  return <form
    action={action}
    className={styles.actionForm}
    onSubmit={(event) => {
      if (nextStatus === "ARCHIVED" && !window.confirm(`Archive “${listingTitle}”? It will leave the active catalog. This status change is recorded.`)) {
        event.preventDefault();
      }
    }}
  >
    <input type="hidden" name="id" value={listingId} />
    <input type="hidden" name="status" value={nextStatus} />
    <button className={primary ? styles.primaryAction : nextStatus === "ARCHIVED" ? styles.archiveAction : styles.secondaryAction} type="submit" aria-label={`${label} ${listingTitle}`}>
      {label}
    </button>
  </form>;
}
