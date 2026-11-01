"use client";

import { useState } from "react";
import styles from "./catalog.module.css";

export function ListingWritingFields({
  enabledInitially,
  price,
  turnaroundDays,
  firstDraftPrice,
  finalDraftPrice,
}: {
  enabledInitially: boolean;
  price: string;
  turnaroundDays: number | "";
  firstDraftPrice: string;
  finalDraftPrice: string;
}) {
  const [enabled, setEnabled] = useState(enabledInitially);

  return <>
    <label>Offer writing?<select
      name="writingEnabled"
      value={enabled ? "yes" : "no"}
      aria-controls="writing-options"
      onChange={(event) => setEnabled(event.currentTarget.value === "yes")}
    ><option value="no">No</option><option value="yes">Yes</option></select></label>
    <p className={styles.hint}>Optional service. Turn it on to set its price and delivery stages.</p>
    <div id="writing-options" className={styles.formGrid} hidden={!enabled}>
      <label>Writing price (USD)<input name="writingPrice" type="number" min="0" step="0.01" defaultValue={price} disabled={!enabled} required={enabled} /></label>
      <label>Writing turnaround (days)<input name="writingTurnaroundDays" type="number" min="1" max="365" defaultValue={turnaroundDays} disabled={!enabled} required={enabled} /></label>
      <label>First draft stage (USD)<input name="writingFirstDraft" type="number" min="0" step="0.01" defaultValue={firstDraftPrice} disabled={!enabled} required={enabled} /></label>
      <label>Final draft stage (USD)<input name="writingFinalDraft" type="number" min="0" step="0.01" defaultValue={finalDraftPrice} disabled={!enabled} required={enabled} /></label>
      <p className={`${styles.hint} ${styles.writingHint}`}>The two disclosed stage prices must add up to the writing price.</p>
    </div>
  </>;
}
