"use client";

import { useState } from "react";
import { contentReviewReasonOptions, fulfillmentTransitionGuidance } from "@/modules/fulfillment/console";
import { updateFulfillmentAction } from "./actions";
import { RedirectingForm } from "./redirecting-form";
import styles from "./fulfillment.module.css";

type Choice = { value: string; label: string };

export function FulfillmentWorkflowActions({ itemId, state, choices, minimumDate, maximumDate, defaultDate }: {
  itemId: string;
  state: string;
  choices: Choice[];
  minimumDate: string;
  maximumDate: string;
  defaultDate: string;
}) {
  const nextSteps = choices.filter((choice) => choice.value !== "ON_HOLD");
  const canPause = choices.some((choice) => choice.value === "ON_HOLD");
  const [selectedStep, setSelectedStep] = useState(nextSteps[0]?.value ?? "");
  const [selectedHoldReason, setSelectedHoldReason] = useState("PAUSED_FOR_REVIEW");
  const currentStep = nextSteps.find((choice) => choice.value === selectedStep) ?? nextSteps[0];
  const holdReasonGuidance = selectedHoldReason === "PAUSED_FOR_REVIEW"
    ? "Choose this when a review is needed but none of the specific content reasons below applies."
    : contentReviewReasonOptions.find((reason) => reason.value === selectedHoldReason)?.description;

  return <>
    {currentStep && <section className={styles.workflowAction}>
      <h3>{state === "ON_HOLD" ? "Resume this placement" : "Next available action"}</h3>
      <p className={styles.helpText}>Choose the action that matches work already completed. It updates the customer stage when the stage changes and saves the next update date.</p>
      <RedirectingForm action={updateFulfillmentAction} className={styles.form}>
        <input type="hidden" name="itemId" value={itemId} />
        {nextSteps.length > 1 && <label htmlFor="fulfillment-next-step">Choose the next action</label>}
        {nextSteps.length > 1
          ? <select id="fulfillment-next-step" name="to" value={selectedStep} onChange={(event) => setSelectedStep(event.currentTarget.value)}>
            {nextSteps.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
          : <input type="hidden" name="to" value={currentStep.value} />}
        {nextSteps.length === 1 && <p className={styles.selectedStep}>{currentStep.label}</p>}
        <p className={styles.scenarioHelp} aria-live="polite">{fulfillmentTransitionGuidance(state, currentStep.value)}</p>
        <label htmlFor="fulfillment-next-update">Next update to the customer</label>
        <input id="fulfillment-next-update" name="nextUpdateAt" type="date" min={minimumDate} max={maximumDate} defaultValue={defaultDate} required />
        <p className={styles.helpText}>The customer sees this date in Orders. Choose a future date within one year.</p>
        <button type="submit">{currentStep.label} and save update date</button>
      </RedirectingForm>
    </section>}

    {canPause && <details className={styles.pauseAction}>
      <summary>Pause this placement for review</summary>
      <p>Use this only when work must stop for an internal review. The customer stays at their current order stage; the pause reason stays private.</p>
      <RedirectingForm action={updateFulfillmentAction} className={styles.form}>
        <input type="hidden" name="itemId" value={itemId} />
        <input type="hidden" name="to" value="ON_HOLD" />
        <label htmlFor="fulfillment-hold-reason">Why does this placement need to pause?</label>
        <select id="fulfillment-hold-reason" name="holdReasonCode" value={selectedHoldReason} onChange={(event) => setSelectedHoldReason(event.currentTarget.value)}>
          <option value="PAUSED_FOR_REVIEW">Another internal review is needed</option>
          {contentReviewReasonOptions.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
        </select>
        <p className={styles.scenarioHelp} aria-live="polite">{holdReasonGuidance}</p>
        <label htmlFor="fulfillment-hold-next-update">Next update to the customer</label>
        <input id="fulfillment-hold-next-update" name="nextUpdateAt" type="date" min={minimumDate} max={maximumDate} defaultValue={defaultDate} required />
        <button type="submit">Pause and save update date</button>
      </RedirectingForm>
    </details>}
  </>;
}
