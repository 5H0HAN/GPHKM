import Link from "next/link";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getSupplierPacket, resendEnvConfigured } from "@/server/fulfillment/packets";
import { logSafeFailure } from "@/server/observability/safe-log";
import { beginManualHandoffAction, markStuckAttemptUnknownAction, recordSupplierAcknowledgementAction, reconcileManualHandoffUnsentAction, reconcilePacketAttemptAction, sendSupplierPacketAction } from "../actions";
import styles from "../packets.module.css";
import { RedirectingForm } from "../../redirecting-form";
import { DeviceTimeField } from "../device-time-field";

export const dynamic = "force-dynamic";
export default async function SupplierPacketPage({ params, searchParams }: { params: Promise<{ packetId: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { packetId } = await params;
  let data: Awaited<ReturnType<typeof getSupplierPacket>>;
  try { data = await getSupplierPacket(await headers(), packetId); } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") redirect("/staff/sign-in");
    if (error instanceof Error && ["Forbidden", "Packet unavailable"].includes(error.message)) notFound();
    const requestId = randomUUID();
    logSafeFailure("supplier_packet_preview_failed", error, requestId, { reasonCode: "PACKET_DETAIL" });
    return <main className={styles.page}>
      <header className={styles.head}><div><p className={styles.eyebrow}>SUPPLIER HANDOFF</p><h1>Packet could not be loaded</h1><p className={styles.muted}>The packet status is temporarily unavailable.</p></div><Link className={styles.link} href="/staff/fulfillment">Back to fulfillment</Link></header>
      <section className={styles.panel}>
        <p className={styles.warning} role="alert">Your previous action may already have completed. Reload this packet and check its current state before trying another action.</p>
        <p className={styles.muted}>If the problem continues, share reference {requestId} with your system administrator.</p>
        <div className={styles.actions}><Link href={`/staff/fulfillment/packets/${encodeURIComponent(packetId)}`}>Reload packet</Link></div>
      </section>
    </main>;
  }
  const { packet, attempts, supplier: supplierContact, stuckAttemptIds, recipientReconsentRetry } = data;
  const stuckAttempts = new Set(stuckAttemptIds);
  const manualPending = attempts.find((attempt) => attempt.type === "MANUAL_SEND" && attempt.state === "SENDING");
  const unresolvedProviderSend = attempts.some((attempt) => attempt.type === "SEND" && ["SENDING", "UNKNOWN"].includes(attempt.state));
  const latestProviderAttempt = attempts.find((attempt) => attempt.type === "SEND");
  const providerOutcomePending = Boolean(latestProviderAttempt && ["SENDING", "UNKNOWN", "ACCEPTED", "DELIVERY_ISSUE"].includes(latestProviderAttempt.state));
  const priorSendExists = attempts.some((attempt) => ["SEND", "MANUAL_SEND", "MANUAL_SENT"].includes(attempt.type));
  const acknowledgementAttempt = data.acknowledgement
    ? attempts.find((attempt) => attempt.id === data.acknowledgement?.attemptId)
    : undefined;
  const manualReceiptAcknowledged = acknowledgementAttempt?.type === "MANUAL_SEND" || acknowledgementAttempt?.type === "MANUAL_SENT";
  const latest = await searchParams;
  const preparedPacketIds = [...new Set((latest.preparedIds ?? "").split(",").filter((id) => /^pkt_[A-Za-z0-9_-]{6,80}$/.test(id)))].slice(0, 25);
  const resendReady = resendEnvConfigured();
  return <main className={styles.page}>
    <header className={styles.head}><div><p className={styles.eyebrow}>IMMUTABLE SUPPLIER PACKET · V{packet.version}</p><h1>{packet.id}</h1><p className={styles.muted}>Order {packet.orderId.slice(0, 8)} · {packet.items.length} placement item{packet.items.length === 1 ? "" : "s"}</p></div><Link className={styles.link} href="/staff/fulfillment/packets/reconciliation">Reconciliation queue</Link></header>
    {latest.error === "acknowledgement" ? <p className={styles.warning} role="alert">Supplier acknowledgement could not be recorded. Confirm delivery or the actual manual send, and check whether an acknowledgement is already recorded.</p> : null}
    {latest.error === "pdf-text" ? <p className={styles.warning} role="alert">The PDF font cannot preserve all packet text. Send without a PDF or export EML.</p> : null}
    {latest.error === "resend-reason" ? <p className={styles.warning} role="alert">A previous send is already recorded. Before sending again, check its delivery status. If a resend is still needed, enter a reason so the new attempt is audited.</p> : null}
    {latest.error === "send" ? <p className={styles.warning} role="alert">{latestProviderAttempt?.state === "ACCEPTED"
      ? "A previous send was accepted by the provider. Check its delivery status before trying again; another send may duplicate the email. If a resend is necessary, enter a reason."
      : "The send could not be completed. Check attempt history and resolve any pending or unclear result before retrying. A resend reason is required after a previous send."}</p> : null}
    {latest.error === "manual-time" ? <p className={styles.warning} role="alert">Enter the actual send time after the reservation began, with the sender’s timezone offset (for example, 2026-11-10T22:45:00+06:00). Do not use a guessed or future time.</p> : null}
    {latest.error === "manual-recipient" ? <p className={styles.warning} role="alert">The actual recipient must match the recipient approved for this packet. If the email went to another address, stop and request fresh customer consent before recording the handoff.</p> : null}
    {latest.error === "manual-reference" ? <p className={styles.warning} role="alert">Enter the sent message’s real reference, such as its Message-ID. Do not invent a reference. Check the mailbox’s Sent folder if needed.</p> : null}
    {latest.error === "manual-evidence" ? <p className={styles.warning} role="alert">Optional evidence must be a valid EML or PDF file no larger than 5 MiB. You can leave evidence blank and record the real sent-message reference.</p> : null}
    {latest.error === "manual-size" ? <p className={styles.warning} role="alert">The submission exceeded the allowed size. Remove evidence or use a valid EML/PDF file up to 5 MiB, then try the confirmation again without sending another email.</p> : null}
    {latest.error === "manual-confirm" ? <p className={styles.warning} role="alert">Confirm that you sent every item in this packet before recording the handoff. If you did not send it, use the separate not-sent reconciliation only after confirming that fact.</p> : null}
    {latest.error === "manual-state" ? <p className={styles.warning} role="alert">The packet or reservation is no longer eligible for this confirmation. Refresh and check Attempt history and the recipient. If a manual reservation is still open, complete or resolve that reservation before starting another one.</p> : null}
    {latest.error === "manual-begin" && recipientReconsentRetry ? <p className={styles.warning} role="alert">This packet is a customer-approved recipient recovery. Use “Send supplier packet” through Resend; manual send and export are not allowed for this retry.</p> : null}
    {latest.error === "manual" ? <p className={styles.warning} role="alert">{manualPending
      ? "GPHKM could not record the manual send, and its reservation is still open. Do not send this packet again while the outcome is unclear. Check the mailbox’s Sent folder: if the email was sent, enter the actual recipient, send time, and message reference below. If it was not sent, resolve the reservation as not sent only after confirming that."
      : "GPHKM could not confirm this manual handoff. Refresh and check Attempt history before taking another action. If the send is recorded, do not send again; if a reservation is still open, reconcile it using the actual outcome."}</p> : null}
    {latest.error && !["acknowledgement", "ack-confirm", "pdf-text", "resend-reason", "send", "manual", "manual-begin", "manual-time", "manual-recipient", "manual-reference", "manual-evidence", "manual-size", "manual-confirm", "manual-state"].includes(latest.error) ? <p className={styles.warning} role="alert">Action could not be completed. Refresh the packet, check its current state, and try again if it remains eligible.</p> : null}
    {data.staleSnapshot ? <section className={styles.panel} role="status"><h2>Historical supplier packet</h2><p className={styles.warning}>The current order, customer approval, or supplier route no longer matches this packet. Its saved contents remain available for review and reconciliation, but it cannot be sent or exported again.</p><p><Link className={styles.link} href={`/staff/fulfillment/packets/new?orderId=${encodeURIComponent(packet.orderId)}`}>Prepare a packet for the current route</Link> · <Link className={styles.link} href="/staff/fulfillment/packets/reconciliation">Review handoff reconciliation</Link></p></section> : null}
    {data.holdReason === "PACKET_SIZE_REVIEW" ? <p className={styles.warning} role="status">This packet exceeded the 5 MiB limit during an earlier attempt and is held for staff review. Current exports and sends recalculate the exact packet size; a successful under-limit action clears this hold and records the review.</p> : null}
    {latest.sent === "1" ? <p className={styles.warning} role="status">Provider send recorded. The customer remains at Preparing until delivery is confirmed by the provider.</p> : null}
    {latest.manual === "1" ? <p className={styles.success} role="status">Manual send recorded. Eligible placements have moved to Publication in Progress. Record supplier receipt separately when the supplier confirms it.</p> : null}
    {latest.manual === "pending" ? <p className={styles.warning} role="status">Manual handoff reserved. Send only this packet version, then record the actual send or reconcile it as unsent.</p> : null}
    {latest.manual === "unsent" ? <p className={styles.warning} role="status">The reservation was resolved as not sent. The attempt remains in the audit history.</p> : null}
    {latest.reconciled === "1" ? <p className={styles.warning} role="status">Attempt reconciliation saved. The packet remains in history; confirm the attempt status and customer milestone below before continuing.</p> : null}
    {latest.acknowledged ? <section className={styles.panel} role="status"><h2>{manualReceiptAcknowledged ? "Supplier receipt confirmed" : "Supplier acknowledgement recorded"}</h2><p className={styles.muted}>{manualReceiptAcknowledged
      ? data.staleSnapshot ? "Receipt is recorded for this packet, but its supplier route is no longer current. Check each placement’s stage before continuing."
        : "Supplier receipt is recorded. Any eligible placements still in Preparing have moved to Publication in Progress; placements already further along keep their stage."
      : "Provider delivery already advanced eligible placements. This records the supplier’s separate acknowledgement."}</p><ul>{packet.items.map((item, index) => <li key={item.orderItemId}><Link className={styles.link} href={`/staff/fulfillment/${encodeURIComponent(item.orderItemId)}`}>Open placement {index + 1} to continue</Link></li>)}</ul></section> : null}
    {preparedPacketIds.length > 1 ? <section className={styles.panel}><h2>Packets prepared for this order</h2><p className={styles.muted}>Each supplier and assigned Admin has a separate packet. Open every packet that needs review.</p><ul>{preparedPacketIds.map((id) => <li key={id}><Link className={styles.link} href={`/staff/fulfillment/packets/${encodeURIComponent(id)}?preparedIds=${encodeURIComponent(preparedPacketIds.join(","))}`}>{id === packet.id ? `Current packet · ${id}` : `Open packet · ${id}`}</Link></li>)}</ul></section> : null}
    <section className={styles.panel}><h2>Exact recipient preview</h2><p><strong>{supplierContact?.name ?? "Supplier"}</strong>{supplierContact?.contactName ? ` · ${supplierContact.contactName}` : ""}</p><p className={styles.muted}>{packet.recipient}</p><p className={styles.muted}>Only the packet below is shared. It excludes customer identity, account and billing information, GPHKM price, and source costs.</p>
      {!data.staleSnapshot && !recipientReconsentRetry ? <div className={styles.actions}><Link href={`/api/staff/fulfillment/packets/${encodeURIComponent(packet.id)}/eml`}>Export EML</Link><Link href={`/api/staff/fulfillment/packets/${encodeURIComponent(packet.id)}/eml?pdf=1`}>Export EML + PDF</Link><Link href={`/api/staff/fulfillment/packets/${encodeURIComponent(packet.id)}/pdf`}>Download PDF</Link></div> : recipientReconsentRetry ? <p className={styles.muted}>Manual exports are unavailable for this recipient-consent recovery. Send through GPHKM after reviewing the packet.</p> : <p className={styles.muted}>Exports are disabled because the current order or supplier details no longer match this saved packet.</p>}
    </section>
    {packet.items.map((item, index) => <section className={styles.panel} key={item.orderItemId}><h2>Placement {index + 1} · {item.reference}</h2>
      {item.placementRequirements.map((requirement) => <p key={requirement}>{requirement}</p>)}<p><strong>Target URL:</strong> {item.targetUrl}</p><p><strong>Anchor text:</strong> {item.anchorText}</p>
      {item.instructions ? <><h3>Instructions</h3><p className={styles.pre}>{item.instructions}</p></> : null}<h3>Approved article</h3><pre className={styles.pre}>{item.article}</pre>
    </section>)}
    <section className={styles.panel}><h2>Send through GPHKM</h2><p className={styles.muted}>{resendReady ? "Email provider configuration is present. Sending still requires the approved provider setup and a deliberate staff action." : "Sending is unavailable until Resend account, sender domain, webhook, and data-handling checks pass. Export EML or PDF for manual handoff."}</p>
      {latestProviderAttempt?.state === "ACCEPTED" ? <p className={styles.warning}>The provider accepted the previous send, but delivery is not confirmed here. Check Resend delivery status or the reconciliation queue before deciding whether to resend.</p> : null}
      {data.staleSnapshot ? <p className={styles.warning}>Sending is disabled because this packet is stale. Prepare and review a new packet after current customer consent is recorded.</p> : !manualPending && !unresolvedProviderSend ? <RedirectingForm action={sendSupplierPacketAction} className={styles.form}><input type="hidden" name="packetId" value={packet.id} /><label>{priorSendExists ? "Reason for resending (required)" : "Resend reason (optional)"}<input name="resendReason" maxLength={1000} required={priorSendExists} /></label><label className={styles.checks}><input type="checkbox" name="attachPdf" /> Attach a selectable-text PDF. The 5 MiB cap covers email body plus PDF.</label><button className={styles.submit} type="submit" disabled={!resendReady}>Send supplier packet</button></RedirectingForm> : <p className={styles.warning}>Another handoff attempt is pending or requires reconciliation. Resolve it before starting another send.</p>}
    </section>
    <section className={styles.panel} id="manual-mail-handoff"><h2>Manual mail handoff</h2>{data.staleSnapshot ? <p className={styles.warning}>Manual handoff is disabled because this packet is stale. Prepare a reviewed packet for the current route and recipient first.</p> : recipientReconsentRetry ? <p className={styles.warning}>Manual handoff is unavailable for this customer-approved recipient recovery. Use “Send supplier packet” through Resend.</p> : manualPending ? <>
      <p className={styles.warning}><strong>Manual handoff reserved.</strong> Started {manualPending.createdAt.toLocaleString()}. This protects the order from cancellation while you finish the handoff. It does not mean the email was sent.</p>
      <ol className={styles.steps}>
        <li><strong>Send this packet.</strong> Download the ready-to-send email and send version {packet.id} v{packet.version} to the approved recipient below.</li>
        <li><strong>Record the actual send.</strong> After sending, enter the actual recipient, time, and message reference below. Do not submit this confirmation before the email is sent.</li>
        <li><strong>Customer stage.</strong> Recording the actual send moves eligible placements to Publication in Progress. Record supplier receipt separately if the supplier confirms it.</li>
      </ol>
      <p><strong>Recipient:</strong> {manualPending.recipient}</p>
      <div className={styles.actions}><Link href={`/api/staff/fulfillment/packets/${encodeURIComponent(packet.id)}/eml`}>Download ready-to-send EML</Link><Link href={`/api/staff/fulfillment/packets/${encodeURIComponent(packet.id)}/eml?pdf=1`}>Download EML + PDF</Link></div>
      <form action={`/api/staff/fulfillment/packets/${encodeURIComponent(packet.id)}/manual`} method="post" encType="multipart/form-data" className={styles.form}>
        <input type="hidden" name="attemptId" value={manualPending.id} />
        <label>Actual recipient<input name="recipient" type="email" defaultValue={manualPending.recipient} required maxLength={254} /></label>
        <DeviceTimeField />
        <label>Message reference<input name="messageReference" required maxLength={320} /></label>
        <p className={styles.muted}>Use a reference from the sent message, such as its Message-ID. Do not invent one.</p>
        <label className={styles.checks}><input type="checkbox" name="confirmAllItems" required /> I sent this complete supplier packet, including every listed order item.</label>
        <label>Private EML or PDF evidence (optional)<input name="evidence" type="file" accept=".eml,.pdf,application/pdf,message/rfc822" /></label>
        <p className={styles.muted}>Up to 5 MiB. Evidence is private, audited, and download-only.</p>
        <button className={styles.submit} type="submit">Confirm packet sent</button>
      </form>
      <form action={reconcileManualHandoffUnsentAction} className={styles.form}><input type="hidden" name="packetId" value={packet.id} /><input type="hidden" name="attemptId" value={manualPending.id} /><label>Reconciliation reason<textarea name="reason" required maxLength={1000} /></label><label className={styles.checks}><input type="checkbox" name="confirmNotSent" required /> I confirm this packet was not sent to the supplier.</label><button className={styles.submit} type="submit">Resolve as not sent</button></form>
      <p className={styles.warning}>A previously downloaded EML or PDF can still be sent outside GPHKM after this reservation is resolved. If that happens, report it to Super Admin immediately and preserve the actual send evidence; do not treat the item as eligible for an ordinary cancellation.</p>
    </> : <>
      <p className={styles.muted}>Use manual email if the provider send failed, stalled, or is still waiting for delivery. Start the audited handoff here, send the ready-to-send EML from your mail app, then record the actual send below.</p>
      {providerOutcomePending ? <p className={styles.warning}>The provider may still deliver its copy, so a duplicate is possible. GPHKM keeps both attempts in history. Recording the actual manual send moves eligible placements to Publication in Progress; supplier receipt remains a separate acknowledgement.</p> : null}
      <form action={beginManualHandoffAction} className={styles.form}><input type="hidden" name="packetId" value={packet.id} /><label>{priorSendExists ? "Why are you sending a manual copy now? (required)" : "Reason for manual handoff (optional)"}<textarea name="resendReason" maxLength={1000} required={priorSendExists} /></label><button className={styles.submit} type="submit">Start manual email handoff</button></form>
    </>}
    </section>
    {attempts.some((attempt) => attempt.state === "UNKNOWN" || attempt.state === "DELIVERY_ISSUE") || stuckAttemptIds.length > 0 ? <section className={styles.panel}><h2>Reconcile unclear send</h2><p className={styles.warning}>A provider resend remains blocked until its outcome is reconciled. If the supplier needs the packet now, use the audited manual email handoff above; keep this provider attempt in history in case it completes later.</p>{attempts.filter((attempt) => stuckAttempts.has(attempt.id)).map((attempt) => <form action={markStuckAttemptUnknownAction} className={styles.form} key={attempt.id}><input type="hidden" name="packetId" value={packet.id} /><input type="hidden" name="attemptId" value={attempt.id} /><p className={styles.muted}>This send has remained in progress for more than 10 minutes. The timeout is an operational recovery heuristic, not a supplier SLA. You may use manual email above now, or review provider records and mark this attempt unknown.</p><label>Review notes<textarea name="reason" required maxLength={1000} /></label><button className={styles.submit} type="submit">Mark unknown for reconciliation</button></form>)}{attempts.filter((attempt) => attempt.state === "UNKNOWN").map((attempt) => <form action={reconcilePacketAttemptAction} className={styles.form} key={attempt.id}><input type="hidden" name="packetId" value={packet.id} /><input type="hidden" name="attemptId" value={attempt.id} /><label>Outcome<select name="outcome"><option value="ACCEPTED">Provider accepted</option><option value="DELIVERY_ISSUE">Delivery issue</option><option value="RECONCILED_FAILED">Provider did not accept</option></select></label><label>Provider message reference<input name="providerReference" maxLength={320} /></label><label>Provider acceptance time (required for accepted or delivery issue)<input type="datetime-local" name="acceptedAt" /></label><label>Reconciliation reason<textarea name="reason" required maxLength={1000} /></label><button className={styles.submit} type="submit">Record reconciliation</button></form>)}{attempts.filter((attempt) => attempt.state === "DELIVERY_ISSUE").map((attempt) => <form action={reconcilePacketAttemptAction} className={styles.form} key={attempt.id}><input type="hidden" name="packetId" value={packet.id} /><input type="hidden" name="attemptId" value={attempt.id} /><input type="hidden" name="deliveryIssue" value="1" /><input type="hidden" name="outcome" value="RECONCILED_FAILED" /><p className={styles.muted}>Confirm from provider records that this email was not delivered. If delivery remains uncertain, keep the route blocked and investigate further.</p><label>Reconciliation reason<textarea name="reason" required maxLength={1000} /></label><label className={styles.checks}><input type="checkbox" name="confirmNotDelivered" required /> I confirmed this email was not delivered.</label><button className={styles.submit} type="submit">Confirm not delivered</button></form>)}</section> : null}
    <section className={styles.panel}><h2>Attempt history</h2>{attempts.length ? <table className={`${styles.table} ${styles.reconciliationTable}`}><thead><tr><th scope="col">Type</th><th scope="col">State</th><th scope="col">Reference</th><th scope="col">Created</th><th scope="col">Accepted / delivered</th></tr></thead><tbody>{attempts.map((attempt) => <tr key={attempt.id}><td data-label="Type">{attempt.type}</td><td data-label="State">{attempt.state}</td><td data-label="Reference">{attempt.providerReference ?? attempt.manualMessageReference ?? "—"}</td><td data-label="Created">{attempt.createdAt.toLocaleString()}</td><td data-label="Accepted / delivered">{attempt.acceptedAt?.toLocaleString() ?? attempt.deliveredAt?.toLocaleString() ?? "—"}</td></tr>)}</tbody></table> : <p className={styles.muted}>No handoff attempts recorded.</p>}{data.manualEvidence.length > 0 && <><h3>Manual handoff evidence</h3><ul>{data.manualEvidence.map((evidence) => <li key={evidence.id}><a href={`/api/staff/fulfillment/packets/${encodeURIComponent(packet.id)}/evidence/${encodeURIComponent(evidence.id)}`}>Download {evidence.fileKind} · {evidence.createdAt.toLocaleString()}</a></li>)}</ul></>}</section>
    <section className={styles.panel} id="supplier-acknowledgement"><h2>Record supplier receipt</h2>{data.acknowledgement ? <p className={styles.muted}>Recorded {data.acknowledgement.acknowledgedAt.toLocaleString()} by staff. Reference: {data.acknowledgement.reference}</p> : <>
      <p className={styles.muted}>If the supplier replies or confirms receipt, record that fact here. This is separate from the customer stage: provider-confirmed delivery or a recorded actual manual send moves eligible placements to Publication in Progress.</p>
      {latest.error === "ack-confirm" ? <p className={styles.warning} role="alert">Confirm that the supplier has actually received the packet before recording receipt.</p> : null}
      {(() => {
        const eligibleAttempt = attempts.find((attempt) => attempt.type === "SEND" && attempt.state === "DELIVERED"
          || (attempt.type === "MANUAL_SENT" || attempt.type === "MANUAL_SEND") && attempt.state === "MANUAL_SENT");
        return eligibleAttempt ? <form action={recordSupplierAcknowledgementAction} className={styles.form}>
          <input type="hidden" name="packetId" value={packet.id} /><input type="hidden" name="attemptId" value={eligibleAttempt.id} />
          <label>Supplier’s confirmation reference or short note<input name="reference" required maxLength={320} /></label>
          <label className={styles.checks}><input type="checkbox" name="confirmSupplierReceipt" required /> The supplier has confirmed they received this packet.</label>
          <button className={styles.submit} type="submit">Record supplier receipt</button>
        </form> : <p className={styles.muted}>Receipt can be recorded after provider delivery or a recorded actual manual send.</p>;
      })()}
    </>}</section>
  </main>;
}
