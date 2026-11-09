import { reviewContentChangeAction } from "./content-change-actions";

export type StaffContentChange = Readonly<{
  id: string;
  requestNumber: number;
  status: string | null;
  reviewNote: string | null;
  requestedByUserId: string;
  createdAt: Date;
  patch: { targetUrl: string | null; anchorText: string | null; articleText: string | null; instructions: string | null };
  approvedVersion: { version: number; recipientEmail: string; contentHash: string } | null;
}>;

export function ContentChangeReview(props: { itemId: string; requests: readonly StaffContentChange[] }) {
  if (!props.requests.length) return <section><h2>Customer content changes</h2><p>No change requests.</p></section>;
  return <section aria-labelledby="content-change-review">
    <h2 id="content-change-review">Customer content changes</h2>
    <p>Review the text changes against the listing requirements. Approval creates a new immutable order content version and waits for the ordering customer’s consent before handoff.</p>
    {props.requests.map((request) => <article key={request.id}>
      <h3>Request {request.requestNumber}: {request.status?.replaceAll("_", " ").toLowerCase() ?? "unavailable"}</h3>
      <p>Submitted {request.createdAt.toLocaleString()} by ordering customer {request.requestedByUserId}</p>
      {request.status === "STALE" && <p role="status">{request.reviewNote ?? "This recipient approval is no longer active and cannot authorize a supplier packet."}</p>}
      <dl>
        {request.patch.targetUrl !== null && <><dt>Requested target URL</dt><dd>{request.patch.targetUrl}</dd></>}
        {request.patch.anchorText !== null && <><dt>Requested anchor</dt><dd>{request.patch.anchorText}</dd></>}
      </dl>
      {request.patch.articleText !== null && <><h4>Replacement article</h4><pre>{request.patch.articleText}</pre></>}
      {request.patch.instructions !== null && <><h4>Additional instructions</h4><pre>{request.patch.instructions}</pre></>}
      {request.status === "REQUESTED" && <>
        <form action={reviewContentChangeAction}>
          <input type="hidden" name="itemId" value={props.itemId} />
          <input type="hidden" name="requestId" value={request.id} />
          <input type="hidden" name="decision" value="APPROVE" />
          <button type="submit">Approve requested content</button>
        </form>
        <form action={reviewContentChangeAction}>
          <input type="hidden" name="itemId" value={props.itemId} />
          <input type="hidden" name="requestId" value={request.id} />
          <input type="hidden" name="decision" value="REJECT" />
          <label>Reason for customer<textarea name="reason" maxLength={1000} minLength={2} required rows={3} /></label>
          <button type="submit">Reject request</button>
        </form>
      </>}
      {request.approvedVersion && request.status === "STALE" && <p>Approved version {request.approvedVersion.version} is retained for audit and cannot be used for packet generation.</p>}
      {request.approvedVersion && request.status === "CONSENTED" && <p>Customer consent was recorded for approved version {request.approvedVersion.version}, bound to recipient {request.approvedVersion.recipientEmail} and content SHA-256 {request.approvedVersion.contentHash}.</p>}
      {request.approvedVersion && request.status === "APPROVED_AWAITING_CONSENT" && <p>Approved version {request.approvedVersion.version} is bound to recipient {request.approvedVersion.recipientEmail} and content SHA-256 {request.approvedVersion.contentHash}; waiting for customer consent before packet generation.</p>}
      {request.approvedVersion && request.status !== "STALE" && request.status !== "CONSENTED" && request.status !== "APPROVED_AWAITING_CONSENT" && <p>Approved version {request.approvedVersion.version} is retained while this request is {request.status?.replaceAll("_", " ").toLowerCase() ?? "unavailable"}.</p>}
    </article>)}
  </section>;
}
