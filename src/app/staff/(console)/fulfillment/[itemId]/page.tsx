import Link from "next/link";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { customerOrderStages, customerStageSummary, fulfillmentStateLabel, fulfillmentTransitionChoices, maximumNextUpdateDate, minimumNextUpdateDate, nextUpdateDateInputValue } from "@/modules/fulfillment/console";
import { getFulfillmentItem } from "@/server/fulfillment/admin";
import { createEquivalentOfferAction, recoverSupplierFailureAction, recordPublicationEvidenceAction, recordSupplierFailureAction, saveWritingDraftAction, updateFulfillmentFollowUpAction } from "../actions";
import { ContentChangeReview } from "./content-change-review";
import { listContentChangesForStaff } from "@/server/orders/content-changes";
import { listEquivalentOfferCandidates } from "@/server/fulfillment/equivalent-offers";
import { listPublicationCorrections } from "@/server/fulfillment/publication-corrections";
import { openPublicationCorrectionAction } from "./correction-actions";
import styles from "../fulfillment.module.css";
import { logSafeFailure } from "@/server/observability/safe-log";
import { RedirectingForm } from "../redirecting-form";
import { FulfillmentWorkflowActions } from "../workflow-actions";

export default async function FulfillmentItemPage({ params, searchParams }: { params: Promise<{ itemId: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const [{ itemId }, query] = await Promise.all([params, searchParams]);
  let result;
  const requestHeaders = await headers();
  try { result = await getFulfillmentItem(requestHeaders, itemId); }
  catch (error) {
    if (error instanceof Error && error.message === "Item unavailable") notFound();
    if (error instanceof Error && error.message === "Forbidden") return <>
      <header className={styles.header}><div><p className={styles.eyebrow}>FULFILLMENT ITEM</p><h1>Item unavailable</h1><p className={styles.lede}>This item is not available to your staff account.</p></div><Link className={styles.open} href="/staff/fulfillment">Back to queue</Link></header>
      <section className={styles.panel}><p role="status">No order content or item details are shown.</p></section>
    </>;
    const requestId = randomUUID();
    logSafeFailure("fulfillment_item_load_failed", error, requestId, { reasonCode: "ITEM_DETAIL" });
    return <>
      <header className={styles.header}><div><p className={styles.eyebrow}>FULFILLMENT ITEM</p><h1>Item could not be loaded</h1><p className={styles.lede}>The item status is temporarily unavailable.</p></div><Link className={styles.open} href="/staff/fulfillment">Back to queue</Link></header>
      <section className={styles.panel}>
        <p className={styles.error} role="alert">Your previous action may already have completed. Reload this item and check its current state before trying another action.</p>
        <p className={styles.help}>If the problem continues, share reference {requestId} with your system administrator.</p>
        <Link className={styles.open} href={`/staff/fulfillment/${encodeURIComponent(itemId)}`}>Reload item</Link>
      </section>
    </>;
  }
  const contentChanges = await listContentChangesForStaff(requestHeaders, itemId).catch(() => []);
  const corrections = await listPublicationCorrections(requestHeaders, itemId).catch(() => []);
  const equivalentCandidates = result.canOfferEquivalent ? await listEquivalentOfferCandidates(requestHeaders, itemId).catch(() => []) : [];
  const currentRouteOutcomes = result.outcomes.filter((outcome) => outcome.supplierId === result.supplier?.id && outcome.routeGeneration === result.supplier?.routeGeneration);
  const writingApproved = !result.item.writingSelected || result.writing?.state === "APPROVED_FIRST" || result.writing?.state === "APPROVED_FINAL";
  const choices = fulfillmentTransitionChoices(result.fulfillment.state, result.fulfillment.stateBeforeHold, Boolean(result.supplier), writingApproved, result.supplierHandoffConfirmed);
  const forwardChoices = choices.filter((choice) => choice.value !== "ON_HOLD");
  const listing = result.item.listingSnapshot as Record<string, unknown>;
  const state = result.fulfillment.state;
  const terminal = state === "COMPLETED" || state === "CANCELED_REFUNDED";
  const awaitingSupplier = state === "HANDOFF_PENDING" && Boolean(result.supplier) && !result.supplierHandoffConfirmed;
  const packetNeeded = state === "READY_FOR_HANDOFF" && Boolean(result.supplier);
  const customerStage = customerStageSummary(result.fulfillment.customerStatus);
  const validationNow = new Date();
  const minimumDate = minimumNextUpdateDate(validationNow);
  const maximumDate = maximumNextUpdateDate(validationNow);
  const nextUpdateDate = nextUpdateDateInputValue(result.fulfillment.nextUpdateAt, minimumDate, maximumDate);
  const packetProgress = result.currentPacket?.attemptState === "MANUAL_SENT"
    ? "A manual send is recorded and the customer is now at Publication in Progress. Supplier receipt is tracked separately on the packet page."
    : result.currentPacket?.attemptState === "DELIVERED"
      ? "The provider confirmed delivery. If the item still appears to be waiting, ask a Super Admin to review the packet history."
      : result.currentPacket?.attemptState === "ACCEPTED" ? "The email provider accepted the packet. The customer stays at Preparing until delivery is confirmed."
      : result.currentPacket?.attemptState === "SENDING" ? "The packet is being sent. Check its status before trying again."
        : result.currentPacket?.attemptState === "UNKNOWN" ? "The send result is unclear. Review the packet before taking another action."
          : result.currentPacket?.attemptState === "DELIVERY_ISSUE" ? "The packet has a delivery problem. Review it before contacting the supplier another way."
            : result.currentPacket?.attemptState === "EXPORTED" ? "A packet file was exported, but no send or supplier receipt is recorded yet."
              : result.currentPacket ? "A packet exists, but supplier delivery is not confirmed yet."
                : "No current packet is recorded. Ask a Super Admin to review the supplier route before continuing.";
  const customerStageGuidance = customerStage.resolved
    ? "Resolved means the placement was canceled and refunded. It is separate from successful completion."
    : state === "COMPLETED"
      ? "Complete is recorded only after staff saves and verifies the live publication URL."
      : state === "CANCELLATION_REQUESTED"
        ? `Cancellation is under review; the customer continues to see ${customerStage.label} until the request is resolved.`
        : state === "ON_HOLD"
          ? `This placement is paused internally; the customer continues to see ${customerStage.label}. Resume from the saved step after resolving the review.`
          : awaitingSupplier
            ? "The customer stays at Preparing until provider delivery is confirmed or staff records the actual manual send. Either advances the customer to Publication in Progress. Supplier receipt is tracked separately. When placement work is finished, Start link verification becomes available; the Verify live publication form appears at Link verification."
            : packetNeeded
              ? "The customer sees Preparing. Prepare the supplier packet first; provider delivery or recording the actual manual send then moves the customer to Publication in Progress."
                : state === "CONFIRMED"
                  ? "The customer sees Order received. Save Start content review when an Admin begins reviewing the article and placement requirements."
                  : state === "CONTENT_PREPARATION" || state === "AWAITING_CUSTOMER_APPROVAL"
                    ? "The customer sees Content review. The stage changes to Preparing only after the content is ready for placement."
              : state === "IN_FULFILLMENT"
                ? "The customer sees Publication in progress. Move to Link verification only after placement work is finished."
                : state === "PUBLICATION_PENDING" || state === "EVIDENCE_REVIEW"
                  ? "The customer sees Link verification. Record a verified live URL to move the placement to Complete."
                  : "Saving the appropriate work step updates the customer stage. Changing the next-update date alone does not move progress.";
  return <>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>FULFILLMENT ITEM</p><h1>{String(listing.title ?? result.fulfillment.listingTitle)}</h1><p className={styles.lede}>Internal work record. Customer updates use GPHKM milestone names and never include sourcing details.</p></div>
      <Link className={styles.open} href="/staff/fulfillment">Back to queue</Link>
    </header>
    {query.error === "update-failed" && <p className={styles.error} role="alert">We couldn’t confirm whether the update was saved. Review the current milestone and required fields before trying again.</p>}
    {query.error === "follow-up-failed" && <p className={styles.error} role="alert">We couldn’t confirm whether the update date was saved. Check the date shown below before trying again.</p>}
    {query.error === "next-update-date" && <p className={styles.error} role="alert">Choose a future date within the next year, then save again.</p>}
    {query.error === "hold-reason" && <p className={styles.error} role="alert">Choose a valid reason for pausing this placement.</p>}
    {query.error === "packet-required" && <p className={styles.error} role="alert">Prepare the supplier packet before moving this item into Preparing. The packet step records the approved content and current recipient consent.</p>}
    {query.error === "delivery-required" && <p className={styles.error} role="alert">Placement work cannot start until provider delivery is confirmed or the actual manual send is recorded on the packet page.</p>}
    {query.updated && <p className={styles.success}>Placement progress saved.</p>}
    {query.followUpUpdated && <p className={styles.success}>Next customer update date saved.</p>}
    {query.verified && <p className={styles.success}>The live URL was recorded and the item marked complete.</p>}
    {query.correctionOpened && <p className={styles.success}>The incorrect verification was recorded. The item is back in link verification.</p>}
    {query.error === "publication-correction-failed" && <p className={styles.error}>The correction could not be recorded. Refresh the item and review its current verification state.</p>}
    {query.writing && <p className={styles.success}>The writing draft was saved for customer review.</p>}
    {query.supplierOutcome && <p className={styles.success}>The supplier outcome was recorded and a GPHKM Support case was opened for the customer.</p>}
    {query.error === "supplier-outcome-failed" && <p className={styles.error} role="alert">The supplier issue was not recorded. Confirm the response or missed follow-up and check this item’s current status before trying again.</p>}
    {query.supplierRecovered && <p className={styles.success}>Renewed availability was recorded. The previous supplier failure remains in the audit history, and a customer-visible Support update was added. The item is still on hold; resume it through the fulfillment workflow after reviewing its current content and recipient consent.</p>}
    {query.error === "supplier-recovery-failed" && <p className={styles.error}>Recovery was not recorded. Confirm this item is still assigned to you, on hold, on the same active supplier route, and has no prior packet attempt or handoff.</p>}
    {query.equivalentOffered && <p className={styles.success}>The same-price alternative was sent to the customer for approval. Handoff remains blocked until the customer decides.</p>}
    {query.error === "equivalent-offer-failed" && <p className={styles.error}>The alternative could not be offered. Check the listing, current item state, and Support case before trying again.</p>}
    <section className={`${styles.panel} ${styles.stagePanel}`} aria-labelledby="customer-stage-title">
      <div className={styles.stageHeader}>
        <div>
          <h2 id="customer-stage-title">Customer-facing placement progress</h2>
          <p>Each placement in a multi-placement order moves through these stages independently.</p>
        </div>
        <div className={styles.currentStatus}>
          <span>Customer currently sees</span>
          <strong>{customerStage.stageNumber ? `Stage ${customerStage.stageNumber} of ${customerStage.totalStages} · ` : ""}{customerStage.label}</strong>
        </div>
      </div>
      {customerStage.index >= 0 ? <ol className={styles.customerStageTrack} aria-label="Customer placement stages">
        {customerOrderStages.map(([value, label], index) => {
          const current = index === customerStage.index;
          const reached = index < customerStage.index;
          return <li key={value} data-stage-state={current ? "current" : reached ? "reached" : "upcoming"} aria-current={current ? "step" : undefined}>
            <span className={styles.stageNumber}>{reached ? "✓" : index + 1}</span>
            <strong>{label}</strong>
            <span className={styles.stageState}>{current ? "Current" : reached ? "Reached" : "Next"}</span>
          </li>;
        })}
      </ol> : <p className={styles.stageResolved}>Resolved after cancellation/refund. This is different from successful completion.</p>}
      <p className={styles.stageGuidance}>{customerStageGuidance}</p>
    </section>
    <div className={styles.detailGrid}>
      <section className={styles.panel}>
        <h2>Order content</h2>
        <dl className={styles.facts}>
          <div><dt>Order</dt><dd>#{result.fulfillment.orderId.slice(0, 8).toUpperCase()}</dd></div>
          <div><dt>Staff work status</dt><dd>{fulfillmentStateLabel(state)}</dd></div>
          <div><dt>Customer placement stage</dt><dd>{customerStage.stageNumber ? `Stage ${customerStage.stageNumber} of ${customerStage.totalStages} · ` : ""}{customerStage.label}</dd></div>
          <div><dt>Next customer update</dt><dd>{result.fulfillment.nextUpdateAt?.toLocaleDateString() ?? "Not scheduled"}</dd></div>
          <div><dt>Target URL</dt><dd className={styles.break}>{result.item.targetUrl}</dd></div>
          <div><dt>Anchor text</dt><dd>{result.item.anchorText}</dd></div>
          <div><dt>Placement requirements</dt><dd>{String(listing.buyerRequirements ?? "No additional requirements")}</dd></div>
          {result.item.instructions && <div><dt>Publication instructions</dt><dd className={styles.content}>{result.item.instructions}</dd></div>}
        </dl>
        {result.item.writingSelected ? <><h3>Customer writing brief</h3><pre className={styles.content}>{result.item.writingBrief}</pre></> : <><h3>Customer article</h3><pre className={styles.content}>{result.item.articleText}</pre></>}
      </section>
      <aside className={styles.sideColumn}>
        <section className={styles.panel}>
          <h2>Fulfillment contact</h2>
          {result.supplier ? <dl className={styles.facts}><div><dt>Contact</dt><dd>{result.supplier.contactName ?? result.supplier.name}</dd></div><div><dt>Email</dt><dd>{result.supplier.email ?? "No primary email"}</dd></div></dl> : <p>No external fulfillment contact is assigned.</p>}
          <p className={styles.help}>Contact details are private staff information. This page does not send an email.</p>
        </section>
        <section className={`${styles.panel} ${styles.nextStepPanel}`}>
          <h2>What happens next</h2>
          <div className={styles.currentStatus}><span>Customer currently sees</span><strong>{customerStage.label}</strong></div>
          {awaitingSupplier ? <>
            <h3>Waiting for delivery confirmation</h3>
            <p>{packetProgress}</p>
            {result.currentPacket && <>
              <p className={styles.help}>This opens the packet page. The customer’s stage changes after delivery is confirmed or an actual manual send is recorded there.</p>
              <a className={styles.open} href={`/staff/fulfillment/packets/${encodeURIComponent(result.currentPacket.id)}#manual-mail-handoff`}>Open packet handoff</a>
            </>}
          </> : packetNeeded ? <>
            <h3>Prepare the supplier packet</h3>
            <p>Review the approved content and the current recipient consent. Preparing the packet records exactly what will be shared.</p>
            <Link className={styles.open} href={`/staff/fulfillment/packets/new?orderId=${encodeURIComponent(result.fulfillment.orderId)}`}>Prepare supplier packet</Link>
          </> : state === "ON_HOLD" ? <>
            <h3>Resolve the review, then resume</h3>
            <p>The placement is paused. Review the Support conversation and the reason for the pause, then resume from the saved work step when it is safe to continue.</p>
          </> : terminal ? <>
            <h3>This placement is finished</h3>
            <p>No further progress update is needed.</p>
          </> : state === "CANCELLATION_REQUESTED" ? <>
            <h3>Review the customer’s cancellation request</h3>
            <p>Resolve the request through its order Support conversation before continuing placement work.</p>
          </> : <>
            <h3>{forwardChoices[0]?.label ?? "Review this item"}</h3>
            <p>Use “Change placement progress” below only after the work described there has happened.</p>
          </>}
        </section>
      </aside>
    </div>
    <section className={`${styles.panel} ${styles.customerUpdates}`}>
      <h2>Customer stage and update date</h2>
      <p>Saving a date changes when the customer expects an update. The available stage action changes progress only when the work is ready.</p>
      <div className={styles.updateColumns}>
        <section className={styles.updateCard}>
          <h3>Schedule the next customer update</h3>
          <p>The customer sees this date in their Orders page. Saving it does not send a message or change placement progress.</p>
          {!terminal ? <RedirectingForm action={updateFulfillmentFollowUpAction} className={styles.form}>
            <input type="hidden" name="itemId" value={itemId} />
            <input type="hidden" name="reasonCode" value="PUBLICATION_UPDATE" />
            <label htmlFor="customer-next-update">Next update date</label>
            <input id="customer-next-update" name="nextUpdateAt" type="date" min={minimumDate} max={maximumDate} required defaultValue={nextUpdateDate} />
            <p className={styles.helpText}>Choose a future date, within one year.</p>
            <button type="submit">Save update date</button>
          </RedirectingForm> : <p className={styles.help}>This placement is finished, so no further update date is needed.</p>}
        </section>
        <section className={styles.updateCard}>
          <h3>Advance the customer stage</h3>
          {awaitingSupplier ? <p>The provider has not confirmed delivery, so there is no generic stage override. Review the packet status above: provider delivery or recording the actual manual email send advances the customer to “Publication in Progress.” After the placement is published, “Start link verification” becomes available. In “Link verification,” inspect the live page and use the verification form to complete the item.</p>
            : packetNeeded ? <>
              <p>This partner placement needs a packet before it can enter “Preparing.” Use the Prepare supplier packet action in “What happens next” above.</p>
            </> : state === "CANCELLATION_REQUESTED" ? <p>Resolve the customer’s cancellation request in its Support conversation before continuing placement work.</p>
              : terminal ? <p>No progress change is available for a finished placement.</p>
                : forwardChoices.length || choices.some((choice) => choice.value === "ON_HOLD") ? <FulfillmentWorkflowActions
                  itemId={itemId} state={state} choices={choices} minimumDate={minimumDate} maximumDate={maximumDate} defaultDate={nextUpdateDate}
                /> : <p>No next progress step is available right now. Review the current state and Support conversation.</p>}
          {(awaitingSupplier || packetNeeded) && <FulfillmentWorkflowActions
            itemId={itemId} state={state} choices={choices} minimumDate={minimumDate} maximumDate={maximumDate} defaultDate={nextUpdateDate}
          />}
        </section>
      </div>
    </section>
    {result.supplier && !terminal && <section className={`${styles.panel} ${styles.supplierIssue}`}>
      <h2>If the supplier reports a problem</h2>
      <p>Use this only after the supplier confirms a problem or misses the agreed response time. Recording it pauses this placement, adds a private staff note to the order’s Support conversation, and posts a neutral update for the customer. It does not issue a refund or send an email.</p>
      {result.hasOpenSupplierOutcome ? <div className={styles.currentStatus}>
        <strong>A supplier issue is already open for this route.</strong>
        <span>Continue in its Support conversation or use the recovery options below. Do not record the same issue again.</span>
        {currentRouteOutcomes[0] && <Link href={`/staff/support/${currentRouteOutcomes[0].supportCaseId}`}>Open the Support conversation</Link>}
      </div> : <form action={recordSupplierFailureAction} className={styles.form}>
        <input type="hidden" name="itemId" value={itemId} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
        <label htmlFor="supplier-outcome">What did the supplier confirm?</label>
        <select id="supplier-outcome" name="outcome" required defaultValue="">
          <option value="" disabled>Choose the confirmed situation</option>
          <option value="REJECTED">They declined this placement</option>
          <option value="CANNOT_FULFILL">They cannot complete this placement</option>
          <option value="NONRESPONSIVE">They missed the agreed response time</option>
        </select>
        <label htmlFor="supplier-outcome-reason">Private note: what they said or when you followed up</label>
        <textarea id="supplier-outcome-reason" name="reason" required minLength={5} maxLength={2000} rows={4} />
        <p className={styles.helpText}>This note is for staff and will not be shown to the customer.</p>
        <button type="submit">Record supplier issue and update Support</button>
      </form>}
      {result.outcomes.length > 0 && <><h3>Supplier issue history</h3><ul className={styles.evidence}>{result.outcomes.map((outcome) => <li key={outcome.id}><strong>{outcome.outcome === "REJECTED" ? "Supplier declined placement" : outcome.outcome === "CANNOT_FULFILL" ? "Supplier cannot fulfill" : "Supplier response overdue"}</strong><span>{outcome.reason}</span><time dateTime={outcome.createdAt.toISOString()}>{outcome.createdAt.toLocaleString()}</time><Link href={`/staff/support/${outcome.supportCaseId}`}>Open Support conversation</Link></li>)}</ul></>}
      {result.canRecoverSameSupplier && <div className={styles.recovery}>
        <h3>Supplier says they can fulfill after all</h3>
        <p>Use this Super Admin action only after confirming renewed availability. It keeps the original issue in history and updates the customer, but it does not resume work or send a packet.</p>
        <p className={styles.help}>Before preparing a packet, review the latest approved article, placement requirements, current recipient, and sharing consent.</p>
        <form action={recoverSupplierFailureAction} className={styles.form}>
          <input type="hidden" name="itemId" value={itemId} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label htmlFor="supplier-recovery-reason">Private note confirming availability</label>
          <textarea id="supplier-recovery-reason" name="reason" required minLength={5} maxLength={2000} rows={4} />
          <button type="submit">Confirm supplier is available again</button>
        </form>
      </div>}
      {result.recoveries.length > 0 && <><h3>Availability recovery history</h3><ul className={styles.evidence}>{result.recoveries.map((recovery) => <li key={recovery.id}><strong>Route generation {recovery.routeGeneration} · recorded by {recovery.actorName}</strong><span>{recovery.reason}</span><time dateTime={recovery.createdAt.toISOString()}>{recovery.createdAt.toLocaleString()}</time><Link href={`/staff/support/${recovery.supportCaseId}`}>Open Support conversation</Link></li>)}</ul></>}
      {result.canOfferEquivalent && currentRouteOutcomes[0] && equivalentCandidates.length > 0 && <div className={styles.recovery}>
        <h3>Offer a same-price alternative</h3>
        <p>Use this if the supplier cannot fulfill and the customer may prefer another listing. They must approve it before a new handoff.</p>
        <form action={createEquivalentOfferAction} className={styles.form}>
          <input type="hidden" name="itemId" value={itemId} /><input type="hidden" name="caseId" value={currentRouteOutcomes[0].supportCaseId} />
          <label htmlFor="equivalent-listing">Alternative listing</label>
          <select id="equivalent-listing" name="listingId" required defaultValue=""><option value="" disabled>Choose an alternative</option>{equivalentCandidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.title} — {candidate.websiteUrl}</option>)}</select>
          <label htmlFor="equivalent-note">Why it meets the purchased placement terms</label>
          <textarea id="equivalent-note" name="equivalenceNote" required minLength={5} maxLength={1000} rows={3} />
          <button type="submit">Offer this alternative to the customer</button>
        </form>
      </div>}
    </section>}
    {result.item.writingSelected && <section className={styles.panel}>
      <h2>GPHKM Writing review</h2>
      {!result.writing && <p>Writing workflow record is unavailable. Hold supplier handoff and contact a Super Admin.</p>}
      {result.writing?.state === "WAITING_FOR_FIRST_DRAFT" && <form action={saveWritingDraftAction} className={styles.form}>
        <input type="hidden" name="itemId" value={itemId} /><input type="hidden" name="kind" value="FIRST_DRAFT" />
        <label>First complete draft<textarea name="draftText" required maxLength={20000} rows={14} /></label><button type="submit">Submit first draft for customer review</button>
      </form>}
      {result.writing?.state === "FIRST_DRAFT_READY" && <><p>First draft sent to the customer. Waiting for approval or the one included revision request.</p><pre className={styles.content}>{result.writing.firstDraftText}</pre></>}
      {result.writing?.state === "REVISION_REQUESTED" && <><h3>Customer revision request</h3><pre className={styles.content}>{result.writing.revisionRequestText}</pre><h3>First draft</h3><pre className={styles.content}>{result.writing.firstDraftText}</pre>
        <form action={saveWritingDraftAction} className={styles.form}><input type="hidden" name="itemId" value={itemId} /><input type="hidden" name="kind" value="FINAL_DRAFT" /><label>Final draft<textarea name="draftText" required maxLength={20000} rows={14} /></label><button type="submit">Submit final draft for approval</button></form></>}
      {result.writing?.state === "FINAL_DRAFT_READY" && <><p>Final draft sent to the customer for approval.</p><pre className={styles.content}>{result.writing.finalDraftText}</pre></>}
      {(result.writing?.state === "APPROVED_FIRST" || result.writing?.state === "APPROVED_FINAL") && <><p>Customer approved the final article. This approved version is the only writing text eligible for supplier handoff.</p><pre className={styles.content}>{result.writing.approvedArticleText}</pre></>}
    </section>}
    <ContentChangeReview itemId={itemId} requests={contentChanges} />
    {corrections.length > 0 && <section className={styles.panel}>
      <h2>Publication correction history</h2>
      {corrections.map((correction) => <article key={correction.id} className={styles.evidence}>
        <strong>{correction.open ? "Correction open — awaiting new verification" : "Correction resolved by new verification"}</strong>
        <p>{correction.reason}</p>
        {correction.originalEvidence && <p>Original verification: <a href={correction.originalEvidence.liveUrl} target="_blank" rel="noreferrer">{correction.originalEvidence.liveUrl}</a> — {correction.originalEvidence.verifiedAt.toLocaleString()}</p>}
        <ul>{correction.events.map((event) => <li key={`${event.correctionCaseId}-${event.eventType}`}>
          {event.eventType === "OPENED" ? "Correction opened" : "New evidence recorded"} · {event.createdAt.toLocaleString()} · {event.reason}
        </li>)}</ul>
      </article>)}
    </section>}
    {result.fulfillment.state === "COMPLETED" && result.evidence[0] && !corrections.some((correction) => correction.open) && <section className={styles.panel}>
      <h2>Report incorrect verification</h2>
      <p>Use this only when the original verification was wrong, such as recording the wrong live URL. A correctly verified placement that later disappears is not eligible for correction or replacement.</p>
      <form action={openPublicationCorrectionAction} className={styles.form}>
        <input type="hidden" name="itemId" value={itemId} />
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        <label>Why was the original verification incorrect?<textarea name="reason" required minLength={5} maxLength={2000} rows={4} /></label>
        <label>Next customer update date<input name="nextUpdateAt" type="date" min={minimumDate} max={maximumDate} required defaultValue={nextUpdateDate} /></label>
        <button type="submit">Open correction and resume verification</button>
      </form>
    </section>}
    {(result.fulfillment.state === "PUBLICATION_PENDING" || result.fulfillment.state === "EVIDENCE_REVIEW") && <section className={styles.panel}>
      <h2>Verify live publication</h2><p>Open and inspect the publication yourself. GPHKM records this URL and verifier; it does not fetch the site or check Google indexing.</p>
      <form action={recordPublicationEvidenceAction} className={styles.evidenceForm}><input type="hidden" name="itemId" value={itemId} /><label>Live publication URL<input name="liveUrl" type="url" maxLength={2048} required placeholder="https://publisher.example/article" /></label><button type="submit">Record verification and complete</button></form>
      {result.evidence.length > 0 && <ul className={styles.evidence}>{result.evidence.map((entry) => <li key={entry.id}><a href={entry.liveUrl} target="_blank" rel="noreferrer">{entry.liveUrl}</a><time dateTime={entry.verifiedAt.toISOString()}>Verified {entry.verifiedAt.toLocaleString()}</time></li>)}</ul>}
    </section>}
  </>;
}
