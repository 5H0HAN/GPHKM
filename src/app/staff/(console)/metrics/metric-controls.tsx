"use client";

import { useActionState, useState, type ChangeEvent, type ReactNode } from "react";
import { refreshOpenPageRankAction, setMetricRedistributionApprovalAction, type MetricActionState } from "./actions";
import styles from "./metrics.module.css";

const initialState: MetricActionState = { status: "idle" };

export function MetricRefreshForm({
  page,
  canRefresh,
  children,
}: {
  page: number;
  canRefresh: boolean;
  children: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(refreshOpenPageRankAction, initialState);
  const [selectedCount, setSelectedCount] = useState(0);
  const updateSelectedCount = (event: ChangeEvent<HTMLFormElement>) => {
    setSelectedCount(event.currentTarget.querySelectorAll<HTMLInputElement>('input[name="listingId"]:checked').length);
  };

  return <form action={formAction} onChange={updateSelectedCount} aria-busy={pending}>
    <input type="hidden" name="page" value={page} />
    {children}
    <div className={styles.refreshActions}>
      <p aria-live="polite">{selectedCount} listings selected · Maximum 100 per batch</p>
      <button className={styles.primaryButton} type="submit" disabled={!canRefresh || pending || selectedCount === 0}>
        {pending ? "Refreshing metrics…" : "Refresh selected metrics"}
      </button>
    </div>
    {!pending && state.status !== "idle" && <p className={state.status === "success" ? styles.success : styles.error}
      role={state.status === "success" ? "status" : "alert"} aria-live={state.status === "error" ? "assertive" : "polite"}>
      {state.status === "success" && pending ? "Refreshing metrics…" : state.message}
    </p>}
  </form>;
}

export function MetricApprovalForm({
  observationId,
  attributionText,
  evidenceReference,
  reason,
  reviewVersion,
  canApprove,
  canRevoke,
}: {
  observationId: string;
  attributionText: string | null;
  evidenceReference: string | null;
  reason: string | null;
  reviewVersion: string;
  canApprove: boolean;
  canRevoke: boolean;
}) {
  const [state, formAction, pending] = useActionState(setMetricRedistributionApprovalAction, initialState);
  return <form className={styles.reviewForm} action={formAction} aria-busy={pending}>
    <input type="hidden" name="observationId" value={observationId} />
    <fieldset className={styles.reviewFields} key={reviewVersion} disabled={pending} aria-label="Review evidence">
      <label>Attribution text
        <input name="attributionText" defaultValue={attributionText ?? ""} maxLength={300} required />
      </label>
      <label>Rights evidence reference
        <input name="evidenceReference" defaultValue={evidenceReference ?? ""} maxLength={500} minLength={5} required
          placeholder="Ticket or review record ID" />
      </label>
      <label>Review reason
        <textarea name="reason" defaultValue={reason ?? ""} maxLength={1000} minLength={5} required />
      </label>
    </fieldset>
    <div className={styles.reviewActions}>
      {canApprove && <button className={styles.primaryButton} name="decision" value="APPROVED" type="submit" disabled={pending}>
        {pending ? "Saving review…" : "Record attestation"}
      </button>}
      {canRevoke && <button className={styles.secondaryButton} name="decision" value="REVOKED" type="submit" disabled={pending}>
        Revoke attestation
      </button>}
    </div>
    {!pending && state.status !== "idle" && <p className={state.status === "success" ? styles.success : styles.error}
      role={state.status === "success" ? "status" : "alert"} aria-live={state.status === "error" ? "assertive" : "polite"}>
      {state.message}
    </p>}
  </form>;
}
