import { consentToContentChangeAction, submitContentChangeAction } from "./content-change-actions";

export type CustomerApprovedContent = Readonly<{
  version: number;
  targetUrl: string;
  anchorText: string;
  articleText: string | null;
  instructions: string;
}>;

export function ContentChangeForm(props: {
  organizationId: string;
  itemId: string;
  canAct: boolean;
  writingSelected: boolean;
  writingStopped?: boolean;
  targetUrl: string;
  anchorText: string;
  articleText: string | null;
  canRequest: boolean;
  approvedChange?: { requestId: string; content: CustomerApprovedContent } | null;
}) {
  return <section aria-labelledby={`change-${props.itemId}`}>
    <h3 id={`change-${props.itemId}`}>Request a content change</h3>
    <details><summary>Current order content</summary>
      <dl><dt>Target URL</dt><dd>{props.targetUrl}</dd><dt>Anchor text</dt><dd>{props.anchorText}</dd></dl>
      {props.articleText && <><h4>{props.writingSelected ? "Approved GPHKM Writing article" : "Current article"}</h4><pre>{props.articleText}</pre></>}
    </details>
    {props.canRequest && props.canAct ? <form action={submitContentChangeAction}>
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="itemId" value={props.itemId} />
      <input type="hidden" name="writingSelected" value={String(props.writingSelected)} />
      <p>{props.writingStopped ? "GPHKM Writing has stopped. Submit your complete article for review; the placement will stay on hold until it is approved and you consent to sharing it with the publication partner." : "Requests are reviewed by GPHKM before any content is changed. Your purchased order details remain unchanged until a request is approved."}</p>
      <label>Target URL<input name="targetUrl" type="url" maxLength={2048} placeholder="Leave blank to keep the current URL" /></label>
      <label>Anchor text<input name="anchorText" maxLength={200} placeholder="Leave blank to keep the current anchor" /></label>
      {(!props.writingSelected || props.writingStopped) && <label>{props.writingStopped ? "Your complete article" : "Article"}<textarea name="articleText" maxLength={20000} rows={12} required={props.writingStopped} placeholder={props.writingStopped ? "Paste the article you want GPHKM to review" : "Leave blank to keep the current article"} /></label>}
      <label>Publication instructions<textarea name="instructions" maxLength={4000} rows={4} placeholder="Optional text instructions; leave blank to keep the current instructions" /></label>
      <button type="submit">Submit for review</button>
    </form> : <p>{props.canAct ? "Content changes are unavailable while this order item is under review or after fulfillment has started." : "Only the person who placed this order can request a content change."}</p>}
    {props.approvedChange && <div>
      <h4>Review approved content, version {props.approvedChange.content.version}</h4>
      <dl>
        <dt>Target URL</dt><dd>{props.approvedChange.content.targetUrl}</dd>
        <dt>Anchor text</dt><dd>{props.approvedChange.content.anchorText}</dd>
      </dl>
      {props.approvedChange.content.articleText !== null && <><h5>Article to share</h5><pre>{props.approvedChange.content.articleText}</pre></>}
      {props.approvedChange.content.instructions && <><h5>Publication instructions</h5><pre>{props.approvedChange.content.instructions}</pre></>}
      <p>By confirming, you authorize GPHKM to share this exact approved content and the placement instructions with the publication partner that will fulfill your order. Your personal, account, organization, billing, and payment details are not shared.</p>
      {props.canAct ? <form action={consentToContentChangeAction}>
        <input type="hidden" name="organizationId" value={props.organizationId} />
        <input type="hidden" name="requestId" value={props.approvedChange.requestId} />
        <button type="submit">Approve sharing this version</button>
      </form> : <p>Only the person who placed this order can approve sharing a revised version.</p>}
    </div>}
  </section>;
}
