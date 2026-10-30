import Link from "next/link";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { getStaffSupportCase } from "@/server/support/cases";
import { allowedSupportTransitions, supportState } from "@/modules/support/cases";
import { supportFinanceAction, supportMessageAction, supportStateAction } from "../actions";
import { decidePostHandoffRefundAction, requestPostHandoffRefundAction } from "../actions";
import { listPostHandoffRefundsForCase } from "@/server/support/post-handoff-refunds";
import { listSupplierItemNoticesForCase } from "@/server/fulfillment/supplier-notices";
import { markStuckSupplierItemNoticeUnknownAction, prepareSupplierItemNoticeAction, reconcileSupplierItemNoticeAction, recordManualSupplierItemNoticeAction, sendSupplierItemNoticeAction } from "../actions";
import styles from "@/components/support.module.css";

export const dynamic = "force-dynamic";
const label = (value: string) => value.toLowerCase().replaceAll("_", " ");
const usd = (minor: string) => `$${(BigInt(minor) / 100n).toString()}.${(BigInt(minor) % 100n).toString().padStart(2, "0")}`;
const usdInput = (minor: string) => `${BigInt(minor) / 100n}.${(BigInt(minor) % 100n).toString().padStart(2, "0")}`;
export default async function StaffSupportDetail({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Promise<{ error?: string; refundRequested?: string; refundDecided?: string; noticePrepared?: string; noticeSent?: string; noticeReconciled?: string; before?: string | string[] }> }) {
  const { caseId } = await params;
  const query = await searchParams;
  const before = Array.isArray(query.before) ? query.before[0] : query.before;
  const requestHeaders = await headers();
  let result;
  try { result = await getStaffSupportCase(requestHeaders, caseId, before); }
  catch { return <p className={styles.notice}>This case is unavailable to your role or current assignment. <Link href="/staff/support">Return to Support</Link></p>; }
  const { row, events, actorRole } = result;
  const refundRequests = await listPostHandoffRefundsForCase(requestHeaders, caseId).catch(() => []);
  const supplierNotices = await listSupplierItemNoticesForCase(requestHeaders, caseId).catch(() => []);
  const transitions = actorRole === "FINANCE" ? [] : allowedSupportTransitions(supportState(row.state));
  const financeReview = row.state === "FINANCE_REVIEW" && (actorRole === "FINANCE" || actorRole === "SUPER_ADMIN");
  return <>
    <header className={styles.header}><div><h1>Support case</h1><p>{label(row.state)} · Item {row.orderItemId.slice(0, 8)} · Updated {row.updatedAt.toLocaleString()}</p></div><Link className={styles.link} href="/staff/support">All cases</Link></header>
    {query.error && <p role="alert" className={styles.notice}>The action could not be saved. The case may have changed or the selected action may be unavailable. Refresh before trying again.</p>}
    {query.refundRequested && <p role="status" className={styles.notice}>The refund request was sent for Finance review. No wallet credit has been issued yet.</p>}
    {query.refundDecided && <p role="status" className={styles.notice}>The Finance decision was recorded and audited.</p>}
    {query.noticePrepared && <p role="status" className={styles.notice}>A separate item notice was prepared. Review it before sending or exporting.</p>}
    {query.noticeSent && <p role="status" className={styles.notice}>The notice send was recorded. Provider acceptance or manual-send evidence does not mean the supplier stopped work.</p>}
    {query.noticeReconciled && <p role="status" className={styles.notice}>The supplier notice result was recorded and audited.</p>}
    <div className={styles.grid}>
      <section className={styles.panel}><h2>Case history</h2><p className={styles.body}>{row.summary}</p>{events.filter((event) => event.kind !== "OPENED").map((event) => <article className={`${styles.message} ${event.audience !== "CUSTOMER" ? styles.internal : ""}`} key={event.id}><header><strong>{event.audience === "CUSTOMER" ? event.actorKind === "CUSTOMER" ? "Customer reply" : "GPHKM reply" : label(event.audience)} · {label(event.kind)}</strong><time dateTime={event.createdAt.toISOString()}>{event.createdAt.toLocaleString()}</time></header>{event.fromState && <p className={styles.meta}>{label(event.fromState)} → {label(event.toState ?? "")}</p>}{event.decision && <p className={styles.meta}>Outcome: {label(event.decision)}</p>}<p className={styles.body}>{event.body}</p></article>)}
        {result.olderCursor && <nav className={styles.pagination} aria-label="Staff Support case history"><span /> <Link href={`/staff/support/${row.id}?before=${encodeURIComponent(result.olderCursor)}`}>Earlier case history</Link></nav>}
      </section>
      <div>
        {row.state === "FINANCE_REVIEW" && (actorRole === "ADMIN" || actorRole === "SUPER_ADMIN") && <section className={styles.panel}><h2>Request post-handoff wallet refund</h2><p>Only an item-specific Finance or Super Admin approval can credit the organization wallet. This request is reviewed case by case and is not guaranteed.</p><form action={requestPostHandoffRefundAction} className={styles.form}>
          <input type="hidden" name="caseId" value={row.id} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label>Requested amount (USD)<input name="amount" required inputMode="decimal" placeholder="e.g. 50.00" /></label>
          <label>Reason and case evidence summary<textarea name="reason" maxLength={2000} minLength={5} rows={4} required /></label>
          <button type="submit">Send to Finance review</button>
        </form></section>}
        {refundRequests.length > 0 && <section className={styles.panel}><h2>Post-handoff refund history</h2>{refundRequests.map((request) => <article className={styles.message} key={request.id}>
          <header><strong>Request {request.requestNumber} · {label(request.state)}</strong><time dateTime={request.requestedAt.toISOString()}>{request.requestedAt.toLocaleString()}</time></header>
          <p>Requested {usd(request.requestedAmountMinor)} · {request.requestReason}</p>
          {request.decisionReason && <p>Decision: {request.decisionReason}{request.state === "APPROVED" ? ` · Wallet credit ${usd(request.refundMinor)}` : ""}</p>}
          {request.state === "REQUESTED" && row.state === "FINANCE_REVIEW" && (actorRole === "FINANCE" || actorRole === "SUPER_ADMIN") && <form action={decidePostHandoffRefundAction} className={styles.form}>
            <input type="hidden" name="caseId" value={row.id} /><input type="hidden" name="requestId" value={request.id} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <label>Approved amount (USD; may be partial)<input name="amount" required inputMode="decimal" defaultValue={usdInput(request.requestedAmountMinor)} /></label>
            <label>Private decision reason<textarea name="reason" maxLength={1000} minLength={5} rows={3} required /></label>
            <div><button type="submit" name="decision" value="APPROVED">Approve wallet credit</button> <button type="submit" name="decision" value="DENIED">Deny request</button></div>
          </form>}
        </article>)}</section>}
        {actorRole !== "FINANCE" && <section className={styles.panel}><h2>Supplier withdrawal or correction notice</h2><p>Notices are separate from the original packet and remain tied to this item and Support case. Sending or delivery does not confirm that the supplier stopped work or made a correction.</p>
          <form action={prepareSupplierItemNoticeAction} className={styles.form}>
            <input type="hidden" name="caseId" value={row.id} />
            <label>Notice type<select name="type"><option value="WITHDRAWAL">Request stop / withdrawal</option><option value="CORRECTION">Request correction</option></select></label>
            <label>Supplier instruction<textarea name="reason" required minLength={5} maxLength={1000} rows={4} /></label>
            <button type="submit">Prepare separate notice</button>
          </form>
          {supplierNotices.map((notice) => {
            const snapshot = notice.snapshot as { subject: string; body: string; itemReference: string };
            return <article className={styles.message} key={notice.id}><header><strong>{notice.noticeType} · {snapshot.itemReference}</strong><time>{notice.createdAt.toLocaleString()}</time></header><p>To: {notice.recipient}</p><p className={styles.body}>{snapshot.body}</p>
              <Link href={`/api/staff/fulfillment/notices/${notice.id}/eml`}>Export ready-to-send EML</Link>
              {(!notice.attempts.length || ["EXPORTED", "RECONCILED_FAILED"].includes(notice.attempts[0]?.state ?? "")) && <form action={sendSupplierItemNoticeAction} className={styles.form}><input type="hidden" name="caseId" value={row.id} /><input type="hidden" name="noticeId" value={notice.id} /><button type="submit">Send from GPHKM</button></form>}
              {notice.attempts.some((attempt) => attempt.state === "EXPORTED") && (!notice.attempts.length || ["EXPORTED", "RECONCILED_FAILED"].includes(notice.attempts[0]?.state ?? "")) && <form action={recordManualSupplierItemNoticeAction} className={styles.form}>
                <input type="hidden" name="caseId" value={row.id} /><input type="hidden" name="noticeId" value={notice.id} />
                <label>Actual recipient<input name="recipient" type="email" defaultValue={notice.recipient} required /></label>
                <label>Actual sent time (ISO 8601, including timezone)<input name="sentAt" type="text" placeholder="2026-10-29T17:00:00+06:00" pattern="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})" required /></label>
                <label>Email message reference<input name="messageReference" minLength={1} maxLength={320} required /></label><button type="submit">Record manual send</button>
              </form>}
              {notice.attempts.map((attempt) => <div key={attempt.id} className={styles.meta}>Attempt {attempt.state.replaceAll("_", " ").toLowerCase()} · {attempt.createdAt.toLocaleString()}{attempt.providerReference ? ` · ${attempt.providerReference}` : ""}</div>)}
              {notice.attempts.some((attempt) => attempt.state === "SENDING" && Date.now() - attempt.createdAt.getTime() >= 10 * 60 * 1000) && <form action={markStuckSupplierItemNoticeUnknownAction} className={styles.form}>
                <input type="hidden" name="caseId" value={row.id} /><input type="hidden" name="attemptId" value={notice.attempts.find((attempt) => attempt.state === "SENDING")?.id ?? ""} />
                <label>Review the unclear send outcome<textarea name="reason" required minLength={5} maxLength={1000} rows={3} /></label><button type="submit">Move stuck send to reconciliation</button>
              </form>}
              {notice.attempts.some((attempt) => ["UNKNOWN", "ACCEPTED", "MANUAL_SENT"].includes(attempt.state)) && <form action={reconcileSupplierItemNoticeAction} className={styles.form}>
                <input type="hidden" name="caseId" value={row.id} /><input type="hidden" name="attemptId" value={notice.attempts.find((attempt) => ["UNKNOWN", "ACCEPTED", "MANUAL_SENT"].includes(attempt.state))?.id ?? ""} />
                <label>Recorded supplier/provider result<select name="outcome">{notice.attempts.find((attempt) => ["UNKNOWN", "ACCEPTED", "MANUAL_SENT"].includes(attempt.state))?.state === "UNKNOWN" ? <><option value="ACCEPTED">Provider acceptance confirmed</option><option value="RECONCILED_FAILED">Provider did not accept the send</option></> : <><option value="SUPPLIER_STOP_CONFIRMED">Supplier confirmed stop/withdrawal</option><option value="SUPPLIER_CONTINUING">Supplier says work will continue</option><option value="UNABLE_TO_CONFIRM">Unable to confirm supplier action</option></>}</select></label>
                <label>Evidence/reference<textarea name="reason" required minLength={5} maxLength={1000} rows={3} /></label><label>Message or provider reference<input name="reference" maxLength={320} /></label><button type="submit">Record notice result</button>
              </form>}
            </article>;
          })}
        </section>}
        {row.state !== "CLOSED" && <section className={styles.panel}><h2>{actorRole === "FINANCE" ? "Private review note" : "Add a message"}</h2><form action={supportMessageAction} className={styles.form}>
          <input type="hidden" name="caseId" value={row.id} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label>Visibility<select name="audience" defaultValue={actorRole === "FINANCE" ? "FINANCE" : "CUSTOMER"}>{actorRole !== "FINANCE" && <><option value="CUSTOMER">Customer-visible reply</option><option value="INTERNAL">Internal Admin note</option></>}{financeReview && <option value="FINANCE">Private Finance note</option>}</select></label>
          <label>Message<textarea name="body" maxLength={4000} rows={6} required /></label><p>Keep supplier identities and private financial details out of customer-visible replies.</p><button type="submit">Record message</button>
        </form></section>}
        {transitions.length > 0 && <section className={styles.panel}><h2>Update case</h2><form action={supportStateAction} className={styles.form}>
          <input type="hidden" name="caseId" value={row.id} /><input type="hidden" name="expectedState" value={row.state} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label>Next state<select name="to" required>{transitions.map((state) => <option value={state} key={state}>{label(state)}</option>)}</select></label><label>Internal reason<textarea name="reason" maxLength={1000} rows={3} required /></label><button type="submit">Update case</button>
        </form></section>}
        {financeReview && <section className={styles.panel}><h2>Finance review</h2><p>Use the refund request above when an item-specific wallet credit is appropriate. This separate form records a private review note or denial and returns the case to Admin without a wallet credit.</p><form action={supportFinanceAction} className={styles.form}>
          <input type="hidden" name="caseId" value={row.id} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label>Outcome<select name="decision"><option value="MORE_INFORMATION_REQUIRED">More information required</option><option value="DENIED">Exception denied</option></select></label><label>Private review reason<textarea name="reason" maxLength={1000} rows={4} required /></label><button type="submit">Record review and return to Admin</button>
        </form></section>}
      </div>
    </div>
  </>;
}
