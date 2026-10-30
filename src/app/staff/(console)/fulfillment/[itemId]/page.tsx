import Link from "next/link";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { contentReviewReasonOptions, fulfillmentTransitionChoices } from "@/modules/fulfillment/console";
import { getFulfillmentItem } from "@/server/fulfillment/admin";
import { createEquivalentOfferAction, recordPublicationEvidenceAction, recordSupplierFailureAction, saveWritingDraftAction, updateFulfillmentAction, updateFulfillmentFollowUpAction } from "../actions";
import { ContentChangeReview } from "./content-change-review";
import { listContentChangesForStaff } from "@/server/orders/content-changes";
import { listEquivalentOfferCandidates } from "@/server/fulfillment/equivalent-offers";
import { listPublicationCorrections } from "@/server/fulfillment/publication-corrections";
import { openPublicationCorrectionAction } from "./correction-actions";
import styles from "../fulfillment.module.css";

export default async function FulfillmentItemPage({ params, searchParams }: { params: Promise<{ itemId: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const [{ itemId }, query] = await Promise.all([params, searchParams]);
  let result;
  const requestHeaders = await headers();
  try { result = await getFulfillmentItem(requestHeaders, itemId); } catch { notFound(); }
  const contentChanges = await listContentChangesForStaff(requestHeaders, itemId).catch(() => []);
  const corrections = await listPublicationCorrections(requestHeaders, itemId).catch(() => []);
  const equivalentCandidates = result.outcomes.length ? await listEquivalentOfferCandidates(requestHeaders, itemId).catch(() => []) : [];
  const writingApproved = !result.item.writingSelected || result.writing?.state === "APPROVED_FIRST" || result.writing?.state === "APPROVED_FINAL";
  const choices = fulfillmentTransitionChoices(result.fulfillment.state, result.fulfillment.stateBeforeHold, Boolean(result.supplier), writingApproved);
  const listing = result.item.listingSnapshot as Record<string, unknown>;
  return <>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>FULFILLMENT ITEM</p><h1>{String(listing.title ?? result.fulfillment.listingTitle)}</h1><p className={styles.lede}>Internal work record. Customer updates use GPHKM milestone names and never include sourcing details.</p></div>
      <Link className={styles.open} href="/staff/fulfillment">Back to queue</Link>
    </header>
    {query.error && <p className={styles.error}>The update could not be saved. Check the current item state and required fields.</p>}
    {query.updated && <p className={styles.success}>Fulfillment update saved.</p>}
    {query.verified && <p className={styles.success}>The live URL was recorded and the item marked complete.</p>}
    {query.correctionOpened && <p className={styles.success}>The incorrect verification was recorded. The item is back in link verification.</p>}
    {query.error === "publication-correction-failed" && <p className={styles.error}>The correction could not be recorded. Refresh the item and review its current verification state.</p>}
    {query.writing && <p className={styles.success}>The writing draft was saved for customer review.</p>}
    {query.supplierOutcome && <p className={styles.success}>The supplier outcome was recorded and a GPHKM Support case was opened for the customer.</p>}
    {query.equivalentOffered && <p className={styles.success}>The same-price alternative was sent to the customer for approval. Handoff remains blocked until the customer decides.</p>}
    {query.error === "equivalent-offer-failed" && <p className={styles.error}>The alternative could not be offered. Check the listing, current item state, and Support case before trying again.</p>}
    <div className={styles.detailGrid}>
      <section className={styles.panel}>
        <h2>Order content</h2>
        <dl className={styles.facts}>
          <div><dt>Order</dt><dd>{result.fulfillment.orderId}</dd></div>
          <div><dt>Workflow</dt><dd>{result.fulfillment.state.replaceAll("_", " ").toLowerCase()}</dd></div>
          <div><dt>Customer milestone</dt><dd>{result.fulfillment.customerStatus.replaceAll("_", " ").toLowerCase()}</dd></div>
          <div><dt>Next update</dt><dd>{result.fulfillment.nextUpdateAt?.toLocaleDateString() ?? "Not set"}</dd></div>
          <div><dt>Target URL</dt><dd className={styles.break}>{result.item.targetUrl}</dd></div>
          <div><dt>Anchor text</dt><dd>{result.item.anchorText}</dd></div>
          <div><dt>Placement requirements</dt><dd>{String(listing.buyerRequirements ?? "No additional requirements")}</dd></div>
        </dl>
        {result.item.writingSelected ? <><h3>Customer writing brief</h3><pre className={styles.content}>{result.item.writingBrief}</pre></> : <><h3>Customer article</h3><pre className={styles.content}>{result.item.articleText}</pre></>}
      </section>
      <aside className={styles.sideColumn}>
        <section className={styles.panel}>
          <h2>Fulfillment contact</h2>
          {result.supplier ? <dl className={styles.facts}><div><dt>Contact</dt><dd>{result.supplier.contactName ?? result.supplier.name}</dd></div><div><dt>Email</dt><dd>{result.supplier.email ?? "No primary email"}</dd></div></dl> : <p>No external fulfillment contact is assigned.</p>}
          <p className={styles.help}>Contact details are private staff information. This page does not send an email.</p>
        </section>
        {result.supplier && !["COMPLETED", "CANCELED_REFUNDED"].includes(result.fulfillment.state) && <section className={styles.panel}>
          <h2>Supplier outcome</h2>
          <p>Record a confirmed rejection, inability to fulfill, or nonresponse. This creates an audited, item-linked Support case and sends only a neutral customer update. No refund is issued here.</p>
          <form action={recordSupplierFailureAction} className={styles.form}>
            <input type="hidden" name="itemId" value={itemId} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <label>Outcome<select name="outcome" defaultValue="CANNOT_FULFILL"><option value="REJECTED">Supplier rejected the placement</option><option value="CANNOT_FULFILL">Supplier cannot fulfill</option><option value="NONRESPONSIVE">Supplier did not respond</option></select></label>
            <label>Internal evidence and reason<textarea name="reason" required minLength={5} maxLength={2000} rows={4} /></label>
            <button type="submit">Record outcome and open Support case</button>
          </form>
          {result.outcomes.length > 0 && <><h3>Outcome history</h3><ul className={styles.evidence}>{result.outcomes.map((outcome) => <li key={outcome.id}><strong>{outcome.outcome.replaceAll("_", " ")}</strong><span>{outcome.reason}</span><time dateTime={outcome.createdAt.toISOString()}>{outcome.createdAt.toLocaleString()}</time><Link href={`/staff/support/${outcome.supportCaseId}`}>Open Support case</Link></li>)}</ul></>}
          {result.outcomes[0] && equivalentCandidates.length > 0 && <><h3>Offer a same-price alternative</h3><p>Select an active listing whose customer-facing terms meet the purchased offer. The order’s original price remains locked; the customer must approve before any new handoff.</p><form action={createEquivalentOfferAction} className={styles.form}>
            <input type="hidden" name="itemId" value={itemId} /><input type="hidden" name="caseId" value={result.outcomes[0].supportCaseId} />
            <label>Alternative listing<select name="listingId" required defaultValue=""> <option value="" disabled>Select a listing</option>{equivalentCandidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.title} — {candidate.websiteUrl}</option>)}</select></label>
            <label>Why this meets the purchased placement terms<textarea name="equivalenceNote" required minLength={5} maxLength={1000} rows={3} /></label>
            <button type="submit">Send alternative for customer approval</button>
          </form></>}
        </section>}
        <section className={styles.panel}>
          <h2>Customer update</h2>
          <details className={styles.help}><summary>Content review guidance</summary><p>Hold the item when content may violate the platform policy or its listing terms. Record the matching reason below, set a next-update date, and use the item&apos;s Support thread to explain any correction needed. The customer can submit an eligible content change or request cancellation; follow the normal item refund rules if it cannot be corrected. Sensitive topics require review against the listing terms and are not automatically prohibited.</p></details>
          {!["COMPLETED", "CANCELED_REFUNDED"].includes(result.fulfillment.state) && <form action={updateFulfillmentFollowUpAction} className={styles.form}>
            <input type="hidden" name="itemId" value={itemId} />
            <h3>Set a reminder</h3><p className={styles.helpText}>Change the follow-up date without changing the customer&apos;s current milestone.</p>
            <label>Reminder date<input name="nextUpdateAt" type="date" required defaultValue={result.fulfillment.nextUpdateAt?.toISOString().slice(0, 10)} /></label>
            <label>Follow-up reason<select name="reasonCode" defaultValue="PUBLICATION_UPDATE"><option value="PUBLICATION_UPDATE">Progress follow-up</option></select></label>
            <button type="submit">Save reminder</button>
          </form>}
          {choices.length ? <form action={updateFulfillmentAction} className={styles.form}>
            <input type="hidden" name="itemId" value={itemId} />
            <h3>Update the customer</h3><p className={styles.helpText}>Choose the milestone they will see and when they should next hear from us.</p>
            <label>Next workflow step<select name="to" defaultValue={choices[0]?.value}>{choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
            <label>Update reason<select name="reasonCode" defaultValue="PUBLICATION_UPDATE"><option value="PUBLICATION_UPDATE">Progress update</option><option value="CUSTOMER_ACTION_NEEDED">Customer action needed</option><option value="CONTENT_REVIEW">Content review</option><option value="CONTENT_APPROVED">Content approved</option><option value="FULFILLMENT_STARTED">Placement work started</option><option value="PAUSED_FOR_REVIEW">Paused for review</option><option value="RESUMED_WORK">Work resumed</option>{contentReviewReasonOptions.map((reason) => <option value={reason.value} key={reason.value}>{reason.label}</option>)}</select></label>
            <label>Next customer update date<input name="nextUpdateAt" type="date" required /></label>
            <button type="submit">Save customer update</button>
          </form> : <p>This item has no further workflow step available.</p>}
        </section>
      </aside>
    </div>
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
        <label>Next customer update date<input name="nextUpdateAt" type="date" required /></label>
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
