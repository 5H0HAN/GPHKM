import { headers } from "next/headers";
import { getStripeWalletReconciliation } from "@/server/wallet/topups";
import styles from "../reconciliation.module.css";
import { listUnknownCustomerEmails } from "@/server/notifications/reconciliation";
import { reconcileCustomerEmailAction } from "./notification-actions";
import { recordFinanceFindingActionAction, recordStripePayoutBankReviewAction, refreshStripePayoutFactsAction, refreshStripeProviderFactsAction, resolveMissingStripeCheckoutSessionAction, resolveStripeReconciliationAction } from "./finance-actions";
import { RunReconciliationControl } from "./run-reconciliation-control";
import { getLatestFinanceReconciliation, listStripeProviderSnapshots } from "@/server/wallet/finance-reconciliation";
import { listStripePayoutReconciliation } from "@/server/wallet/payout-reconciliation";
import { listAmbiguousStripeCheckoutAttempts, listOpenStripeAttempts } from "@/server/wallet/topups";

export const dynamic = "force-dynamic";

function usd(minor: string | null) {
  if (minor === null) return "—";
  const cents = BigInt(minor);
  const absolute = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "−" : ""}$${(absolute / 100n).toLocaleString("en-US")}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

export default async function ReconciliationPage({ searchParams }: { searchParams: Promise<{ emailReconciled?: string; financeRun?: string; findingReviewed?: string; providerSnapshot?: string; snapshotComplete?: string; stripeResolved?: string; stripePartial?: string; providerLoss?: string; recovered?: string; uncovered?: string; payoutSnapshot?: string; payoutComplete?: string; payoutReview?: string; checkoutSessionResolved?: string }> }) {
  const query = await searchParams;
  let rows: Awaited<ReturnType<typeof getStripeWalletReconciliation>>;
  try { rows = await getStripeWalletReconciliation(await headers()); }
  catch {
    return <main className={styles.main}><header><p className={styles.eyebrow}>FINANCE CONTROLS</p><h1>Reconciliation</h1><p>Access requires an active Finance or Super Admin account and verified staff session.</p></header></main>;
  }
  let unknownEmails: Awaited<ReturnType<typeof listUnknownCustomerEmails>> = [];
  try { unknownEmails = await listUnknownCustomerEmails(await headers()); } catch { /* Finance and Admin cannot view customer email reconciliation. */ }
  const financeSnapshot = await getLatestFinanceReconciliation(await headers());
  const providerSnapshots = await listStripeProviderSnapshots(await headers());
  const payoutSnapshots = await listStripePayoutReconciliation(await headers());
  const openAttempts = await listOpenStripeAttempts(await headers());
  const ambiguousAttempts = await listAmbiguousStripeCheckoutAttempts(await headers());
  return <main className={styles.main}>
    <header><p className={styles.eyebrow}>FINANCE CONTROLS</p><h1>Reconciliation</h1>
      <p>Run consistency checks across the wallet ledger and financial source records. Review notes are audited. Reconciliation decisions post compensating ledger entries; original entries and Stripe event history remain immutable.</p>
    </header>
    {query.financeRun && <p role="status" className={styles.empty}>Reconciliation run {query.financeRun} completed. Review its findings below.</p>}
    {query.findingReviewed === "true" && <p role="status" className={styles.empty}>Finance review recorded in the append-only reconciliation history.</p>}
    {query.providerSnapshot && <p role="status" className={styles.empty}>Current Stripe facts saved as snapshot {query.providerSnapshot}. {query.snapshotComplete === "true" ? "The refund and dispute lists were fully retrieved." : "The provider response is incomplete and cannot support a financial resolution."}</p>}
    {query.stripeResolved === "true" && <p role="status" className={styles.empty}>Stripe review resolved. Provider principal loss: {usd(query.providerLoss ?? null)}; wallet recovery: {usd(query.recovered ?? null)}; recorded uncovered exposure: {usd(query.uncovered ?? null)}.</p>}
    {query.stripePartial === "true" && <p role="status" className={styles.empty}>Partial recovery recorded. Provider principal loss: {usd(query.providerLoss ?? null)}; wallet recovery: {usd(query.recovered ?? null)}; uncovered: {usd(query.uncovered ?? null)}. The case remains open and the organization stays restricted until fully recovered.</p>}
    {query.checkoutSessionResolved && <p role="status" className={styles.empty}>Checkout attempt {query.checkoutSessionResolved} was closed after Finance recorded provider evidence. No wallet balance or ledger entry was changed.</p>}
    <section className={styles.financeSection}>
      <div className={styles.sectionHead}><div><h2>Wallet and order consistency</h2><p>Checks wallet projections, settled top-ups and grants, order debits, item refunds, active holds, and Stripe events that need provider review. Each run is retained as an immutable snapshot.</p></div>
        <RunReconciliationControl /></div>
      {!financeSnapshot ? <div className={styles.empty}><strong>No reconciliation run yet</strong><p>Start a read-only scan. It will not change financial records.</p></div> : <>
        <p className={styles.runMeta}>Latest run: {new Date(financeSnapshot.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC · {financeSnapshot.findingCount} finding{financeSnapshot.findingCount === 1 ? "" : "s"}</p>
        {financeSnapshot.findings.length === 0 ? <div className={styles.empty}><strong>No inconsistencies found in the checks performed</strong><p>Current Stripe snapshots include charge, refund, and dispute balance transactions. This scan does not independently reconcile Stripe payouts to bank settlement records.</p></div> : (
          <div className={styles.tableWrap}><table><thead><tr><th>Finding</th><th>Target</th><th>Organization</th><th>Expected</th><th>Observed</th><th>Review</th></tr></thead><tbody>
            {financeSnapshot.findings.map((finding) => <tr key={finding.id}>
              <td><strong>{finding.category.replaceAll("_", " ")}</strong><small>{finding.summary}</small><small>{finding.outcome ? `${finding.outcome.replaceAll("_", " ")} · ${finding.reviewedAt ? new Date(finding.reviewedAt).toLocaleString("en-US", { timeZone: "UTC" }) + " UTC" : ""}` : "Needs Finance review"}</small></td>
              <td>{finding.targetType}<small>{finding.targetId}</small></td>
              <td>{finding.organizationId ?? "—"}</td>
              <td>{usd(finding.expectedMinor)}</td><td>{usd(finding.observedMinor)}</td>
              <td>{finding.outcome && <p className={styles.reviewNote}><strong>{finding.outcome.replaceAll("_", " ")}</strong><br />{finding.reason}<br /><small>Evidence: {finding.evidenceReference}</small></p>}
                <form action={recordFinanceFindingActionAction} className={styles.financeForm}>
                  <input type="hidden" name="findingId" value={finding.id} />
                  <label>Review outcome<select name="outcome" defaultValue="FOLLOW_UP_REQUIRED"><option value="FOLLOW_UP_REQUIRED">Follow-up required</option><option value="CONFIRMED_EXPECTED">Evidence confirms expected</option></select></label>
                  <label>Evidence reference<input name="evidenceReference" maxLength={200} required /></label>
                  <label>Review note<textarea name="reason" minLength={10} maxLength={1000} required /></label>
                  <button type="submit">Record review</button>
                </form>
              </td>
            </tr>)}
          </tbody></table></div>
        )}
      </>}
    </section>
    <section className={styles.financeSection}>
      <h2>Open top-up attempts</h2>
      <p className={styles.disclaimer}>Read-only visibility for checkout attempts that still hold the one-open-top-up guard. A missing provider session or delayed webhook needs provider evidence before anyone changes its state.</p>
      {openAttempts.length === 0 ? <div className={styles.empty}><strong>No open top-up attempts</strong></div> : (
        <div className={styles.tableWrap}><table><thead><tr><th>Attempt</th><th>Organization</th><th>State</th><th>Amount</th><th>Provider session</th><th>Created</th><th>Last updated</th></tr></thead><tbody>
          {openAttempts.map((attempt) => <tr key={attempt.payment_attempt_id}>
            <td>{attempt.payment_attempt_id}</td><td>{attempt.organization_id}</td><td><span className={styles.status}>{attempt.attempt_state}</span></td>
            <td>{usd(attempt.amount_minor)} {attempt.currency}</td><td>{attempt.has_provider_session ? "Recorded" : "Not recorded"}</td>
            <td>{new Date(attempt.created_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</td>
            <td>{new Date(attempt.updated_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</td>
          </tr>)}
        </tbody></table></div>
      )}
    </section>
    <section className={styles.financeSection}>
      <h2>Stripe event exceptions</h2>
      <p className={styles.disclaimer}>Webhook facts are historical and informational. Finance resolution requires a recent, complete PaymentIntent, Refund, Dispute, and balance transaction snapshot. It posts only recoverable provider principal to the immutable wallet ledger; provider fees are reported separately and are never charged to the customer wallet.</p>
    {rows.length === 0 ? <section className={styles.empty}><strong>No Stripe exceptions</strong><p>Unresolved events and active top-up holds will appear here.</p></section> : (
      <div className={styles.tableWrap}><table><thead><tr>
        <th>Event</th><th>Received</th><th>Attempt</th><th>Organization</th><th>State</th><th>Top-up credit</th><th>Provider event facts</th><th>Active hold</th><th>Ledger</th><th>Current facts</th>
      </tr></thead><tbody>{rows.map((row) => <tr key={row.provider_event_id}>
        <td><strong>{row.event_type}</strong><small>{row.provider_event_id}</small></td>
        <td>{new Date(row.received_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</td>
        <td>{row.payment_attempt_id ?? "Unmatched"}</td>
        <td>{row.organization_id ?? "Unmatched"}</td>
        <td><span className={styles.status}>{row.event_state}{row.attempt_state ? ` / ${row.attempt_state}` : ""}</span></td>
        <td>{usd(row.topup_amount_minor)} {row.topup_currency ?? ""}</td>
        <td>{row.provider_amount_minor === null ? "Not supplied" : `${usd(row.provider_amount_minor)} ${row.provider_currency ?? ""}`}
          {row.event_type === "charge.refunded" && row.provider_amount_minor !== null ? <small>Charge refunded total (cumulative)</small> : null}
          {row.provider_status ? <small>Provider status: {row.provider_status}</small> : null}
        </td>
        <td>{usd(row.active_hold_minor)}{row.hold_reason ? ` · ${row.hold_reason}` : ""}</td>
        <td>{row.topup_ledger_id ?? "—"}</td>
        <td>{row.payment_attempt_id ? <form action={refreshStripeProviderFactsAction}>
          <input type="hidden" name="attemptId" value={row.payment_attempt_id} />
          <button type="submit">Refresh from Stripe</button>
        </form> : "Attempt unavailable"}</td>
      </tr>)}</tbody></table></div>
    )}
    </section>
    <section className={styles.financeSection}>
      <h2>Ambiguous Checkout Session creation</h2>
      <p className={styles.disclaimer}>A checkout request may have reached Stripe even when GPHKM did not receive or save the Session ID. Finance may release the one-open-top-up guard only after 24 hours, provider-side verification that no Session or payment exists, and an evidence reference. This closes the attempt without crediting or debiting the wallet. Never use this for an attempt with a recorded provider event.</p>
      {ambiguousAttempts.length === 0 ? <div className={styles.empty}><strong>No ambiguous session attempts</strong></div> : (
        <div className={styles.tableWrap}><table><thead><tr><th>Attempt</th><th>Organization</th><th>Amount</th><th>Dispatch started</th><th>Provider events</th><th>Resolution</th></tr></thead><tbody>
          {ambiguousAttempts.map((attempt) => <tr key={attempt.payment_attempt_id}>
            <td>{attempt.payment_attempt_id}</td><td>{attempt.organization_id}</td>
            <td>{usd(attempt.amount_minor)} {attempt.currency}</td>
            <td>{new Date(attempt.dispatch_started_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</td>
            <td>{attempt.has_related_provider_event ? "Recorded — use event reconciliation" : "None linked"}</td>
            <td>{attempt.eligible_for_evidence_resolution ? <form action={resolveMissingStripeCheckoutSessionAction} className={styles.financeForm}>
              <input type="hidden" name="attemptId" value={attempt.payment_attempt_id} />
              <label>Stripe Dashboard evidence reference<input name="evidenceReference" maxLength={200} required /></label>
              <label>Attestation and review note<textarea name="reason" minLength={10} maxLength={1000} required /></label>
              <button type="submit">Confirm no session or payment exists</button>
            </form> : <span>Not eligible: wait 24 hours or resolve the linked provider event first.</span>}</td>
          </tr>)}
        </tbody></table></div>
      )}
    </section>
    <section className={styles.financeSection}>
      <h2>Latest current Stripe snapshots</h2>
      <p className={styles.disclaimer}>Only open cases appear here. A Finance resolution requires a recent, complete snapshot with no unsettled refunds or disputes. It records residual exposure separately when wallet funds are insufficient.</p>
      {providerSnapshots.length === 0 ? <div className={styles.empty}><strong>No current Stripe snapshots</strong><p>Use “Refresh from Stripe” on a matched payment event to retrieve the current provider records.</p></div> : (
        <div className={styles.tableWrap}><table><thead><tr><th>Attempt</th><th>Snapshot time</th><th>PaymentIntent</th><th>Refunds</th><th>Disputes</th><th>Retrieval and decision</th></tr></thead><tbody>
          {providerSnapshots.map((snapshot) => <tr key={snapshot.case_id}>
            <td>{snapshot.payment_attempt_id}<small>{snapshot.attempt_state}</small>
              {snapshot.facts?.latestDecision && <small>Latest decision: recovered {usd(snapshot.facts.latestDecision.walletRecoveryMinor)} / {usd(snapshot.facts.latestDecision.providerLossMinor)}; uncovered {usd(snapshot.facts.latestDecision.uncoveredMinor)}. {new Date(snapshot.facts.latestDecision.createdAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC · {snapshot.facts.latestDecision.evidenceReference} · {snapshot.facts.latestDecision.reason}</small>}
            </td>
            <td>{snapshot.snapshot_created_at ? `${new Date(snapshot.snapshot_created_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC` : "No snapshot"}</td>
            {!snapshot.facts || !snapshot.snapshot_id ? <>
              <td colSpan={3}>Current provider facts have not been retrieved for this open case.</td>
              <td><form action={refreshStripeProviderFactsAction}><input type="hidden" name="attemptId" value={snapshot.payment_attempt_id} /><button type="submit">Refresh from Stripe</button></form></td>
            </> : <>
              <td>{snapshot.facts.providerPaymentId}<small>{snapshot.facts.providerMode.toUpperCase()} · {snapshot.facts.paymentStatus} · {usd(snapshot.facts.amountReceivedMinor)} received / {usd(snapshot.facts.amountMinor)} intended</small>
                <small>{snapshot.facts.chargeId ? `Charge ${snapshot.facts.chargeId}` : "No charge recorded"}{snapshot.facts.chargeBalanceTransaction ? ` · balance ${usd(snapshot.facts.chargeBalanceTransaction.amountMinor)}, fee ${usd(snapshot.facts.chargeBalanceTransaction.feeMinor)}, net ${usd(snapshot.facts.chargeBalanceTransaction.netMinor)} ${snapshot.facts.chargeBalanceTransaction.currency.toUpperCase()} · ${snapshot.facts.chargeBalanceTransaction.status}` : " · processing-fee balance transaction unavailable"}</small></td>
              <td>{usd(snapshot.facts.refundedSucceededMinor)} succeeded · {snapshot.facts.pendingRefundCount} pending<small>{snapshot.facts.refunds.map((refund) => `${refund.id}: ${usd(refund.amountMinor)} ${refund.currency.toUpperCase()} · ${refund.status}${refund.balanceTransaction ? ` · BT ${usd(refund.balanceTransaction.amountMinor)}, fee ${usd(refund.balanceTransaction.feeMinor)}, net ${usd(refund.balanceTransaction.netMinor)}` : " · balance transaction unavailable"}`).join("; ") || "No refunds"}</small></td>
              <td>{snapshot.facts.openDisputeCount} open<small>{snapshot.facts.disputes.map((dispute) => `${dispute.id}: ${usd(dispute.amountMinor)} ${dispute.currency.toUpperCase()} · ${dispute.status}${dispute.balanceTransactions.length ? ` · BT ${dispute.balanceTransactions.map((transaction) => `${usd(transaction.amountMinor)} / fee ${usd(transaction.feeMinor)} / net ${usd(transaction.netMinor)}`).join(", ")}` : " · no balance transactions"}`).join("; ") || "No disputes"}</small></td>
              <td>{snapshot.snapshot_complete && snapshot.facts.paginationComplete && snapshot.facts.detailComplete ? "Complete retrieval" : "Incomplete · review required"}
                <form action={resolveStripeReconciliationAction} className={styles.financeForm}>
                  <input type="hidden" name="attemptId" value={snapshot.payment_attempt_id} />
                  <input type="hidden" name="snapshotId" value={snapshot.snapshot_id} />
                  <label>Evidence reference<input name="evidenceReference" maxLength={200} required /></label>
                  <label>Finance decision note<textarea name="reason" minLength={10} maxLength={1000} required /></label>
                <button type="submit" disabled={!snapshot.snapshot_complete || !snapshot.facts.paginationComplete || !snapshot.facts.detailComplete}>Record Finance recovery decision</button>
                </form>
              </td>
            </>}
          </tr>)}
        </tbody></table></div>
      )}
    </section>
    <section className={styles.financeSection}>
      <h2>Stripe payout settlement</h2>
      <p className={styles.disclaimer}>Enter a payout ID from Stripe to retrieve allowlisted payout and balance-transaction facts. Compare a paid payout with the company bank statement and record the statement reference. A staff review is an attestation; GPHKM does not connect to or independently verify the bank.</p>
      {query.payoutSnapshot && <p role="status" className={styles.empty}>Payout snapshot {query.payoutSnapshot} saved. {query.payoutComplete === "true" ? "Provider facts are complete." : "Provider facts are incomplete and cannot be matched."}</p>}
      {query.payoutReview === "true" && <p role="status" className={styles.empty}>Payout bank review recorded in the append-only Finance history.</p>}
      <form action={refreshStripePayoutFactsAction} className={styles.financeForm}>
        <label>Stripe payout ID<input name="payoutId" required pattern="po_[A-Za-z0-9]{6,128}" maxLength={131} placeholder="po_…" /></label>
        <button type="submit">Refresh payout facts</button>
      </form>
      {payoutSnapshots.length === 0 ? <div className={styles.empty}><strong>No payout snapshots</strong><p>Refresh a payout to compare provider records with bank statement evidence.</p></div> : (
        <div className={styles.tableWrap}><table><thead><tr><th>Payout</th><th>Stripe amount and state</th><th>Balance transactions</th><th>Bank comparison</th></tr></thead><tbody>
          {payoutSnapshots.map((snapshot) => <tr key={snapshot.snapshot_id}>
            <td><strong>{snapshot.payout_id}</strong><small>{snapshot.facts.providerMode.toUpperCase()} · refreshed {new Date(snapshot.snapshot_created_at).toLocaleString("en-US", { timeZone: "UTC" })} UTC</small>
              {snapshot.facts.automatic ? <small>Automatic payout · {snapshot.facts.reconciliationStatus.replaceAll("_", " ")}</small> : <small>Manual payout</small>}</td>
            <td>{usd(snapshot.facts.amountMinor)} {snapshot.facts.currency.toUpperCase()}<small>Status: {snapshot.facts.status} · expected arrival {new Date(snapshot.facts.arrivalAt).toLocaleDateString("en-US", { timeZone: "UTC" })} UTC</small></td>
            <td>{snapshot.facts.payoutBalanceTransaction ? `Payout balance impact ${usd(snapshot.facts.payoutBalanceTransaction.netMinor)} ${snapshot.facts.payoutBalanceTransaction.currency.toUpperCase()}` : "Payout balance transaction unavailable"}
              <small>{snapshot.facts.balanceTransactions.length} included transactions · gross {usd(snapshot.facts.transactionsGrossMinor)} · fees {usd(snapshot.facts.transactionsFeeMinor)} · net {usd(snapshot.facts.transactionsNetMinor)} USD</small>
              {!snapshot.facts.transactionsComplete && <small>Itemized transactions are unavailable or still processing.</small>}</td>
            <td>{snapshot.latest_review ? <p className={styles.reviewNote}><strong>{snapshot.latest_review.decision.replaceAll("_", " ")}</strong><br />Bank reported {usd(snapshot.latest_review.bankAmountMinor)} {snapshot.latest_review.bankCurrency.toUpperCase()} on {snapshot.latest_review.bankSettledAt ? new Date(snapshot.latest_review.bankSettledAt).toLocaleDateString("en-US", { timeZone: "UTC" }) : "date not recorded"}.<br /><small>Evidence: {snapshot.latest_review.evidenceReference} · {snapshot.latest_review.reason}</small></p> : <p>No bank review recorded.</p>}
              <form action={recordStripePayoutBankReviewAction} className={styles.financeForm}>
                <input type="hidden" name="snapshotId" value={snapshot.snapshot_id} />
                <label>Decision<select name="decision" defaultValue="FOLLOW_UP_REQUIRED"><option value="FOLLOW_UP_REQUIRED">Follow-up required</option><option value="MATCHED" disabled={!snapshot.snapshot_complete || snapshot.facts.status !== "paid"}>Matched to bank</option></select></label>
                <label>Bank amount (USD)<input name="bankAmount" required inputMode="decimal" placeholder="0.00" /></label>
                <label>Bank settlement date<input name="bankSettledOn" type="date" required /></label>
                <label>Statement/reference ID<input name="evidenceReference" required minLength={3} maxLength={200} /></label>
                <label>Review note<textarea name="reason" required minLength={10} maxLength={1000} /></label>
                <button type="submit">Record bank review</button>
              </form>
            </td>
          </tr>)}
        </tbody></table></div>
      )}
    </section>
    {query.emailReconciled === "true" && <p role="status" className={styles.empty}>Customer email result recorded in the append-only reconciliation history.</p>}
    <section className={styles.emailSection}>
      <h2>Customer email reconciliation</h2>
      <p>Only Super Admin can resolve ambiguous delivery outcomes. Confirm the message in Resend before marking it sent or authorizing a retry.</p>
      {unknownEmails.length === 0 ? <div className={styles.empty}><strong>No unknown customer email outcomes</strong><p>Ambiguous provider results and expired worker leases appear here for review.</p></div> : (
        <div className={styles.tableWrap}><table><thead><tr><th>Outbox record</th><th>Type</th><th>Created</th><th>Attempts</th><th>Last result</th><th>Decision and evidence</th></tr></thead><tbody>
          {unknownEmails.map((row) => <tr key={row.outbox_id}>
            <td><small>{row.outbox_id}</small></td><td>{row.notification_kind.replaceAll("_", " ")}</td>
            <td>{new Date(row.created_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</td>
            <td>{row.attempts}</td><td>{row.error_code ?? "Unknown"}</td>
            <td><form action={reconcileCustomerEmailAction} className={styles.emailForm}>
              <input type="hidden" name="outboxId" value={row.outbox_id} />
              <label>Decision<select name="decision" defaultValue="CONFIRMED_SENT"><option value="CONFIRMED_SENT">Provider confirms sent</option><option value="CONFIRMED_NOT_SENT">Provider confirms not sent; retry</option></select></label>
              <label>Provider email ID<input name="providerReference" maxLength={128} /></label>
              <label>Evidence reference<input name="evidenceReference" maxLength={200} required /></label>
              <label>Reason<textarea name="reason" minLength={10} maxLength={1000} required /></label>
              <button type="submit">Record decision</button>
            </form></td>
          </tr>)}
        </tbody></table></div>
      )}
    </section>
  </main>;
}
