import { headers } from "next/headers";
import Link from "next/link";
import { getMyOrdersPage } from "@/server/orders/checkout";
import { updateCustomerWritingAction } from "./actions";
import { OrderItemCancellationForm } from "./cancellation-form";
import { ContentChangeForm } from "./content-change-form";
import { listContentChangesForCustomer } from "@/server/orders/content-changes";
import { loadCustomerWorkspace, selectedOrganizationId } from "../workspace";
import { listCustomerEquivalentOffers } from "@/server/fulfillment/equivalent-offers";
import { EquivalentOfferCard } from "./equivalent-offer-card";
import styles from "../customer.module.css";

export const dynamic = "force-dynamic";

function label(value: string) {
  return value.toLowerCase().split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function dollars(minor: string) {
  const amount = BigInt(minor);
  return `$${(amount / 100n).toLocaleString("en-US")}.${(amount % 100n).toString().padStart(2, "0")}`;
}

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ organizationId?: string | string[]; page?: string | string[]; placed?: string; writingUpdated?: string; writingError?: string; cancellationRequested?: string; cancellationError?: string; cancellationUpdated?: string; changeSubmitted?: string; changeConsented?: string; changeError?: string; equivalentUpdated?: string; equivalentError?: string }> }) {
  const workspace = await loadCustomerWorkspace();
  if (!workspace.authenticated) return null;
  const params = await searchParams;
  const organizationId = selectedOrganizationId(workspace.organizations, Array.isArray(params.organizationId) ? params.organizationId[0] : params.organizationId);
  if (!organizationId) return <div className={styles.error}>An organization is required to view orders.</div>;
  let result;
  try { result = await getMyOrdersPage(await headers(), organizationId, params.page); }
  catch { return <div className={styles.error}>Order details could not be loaded. Refresh or contact support if this continues.</div>; }
  const { orders, page, totalPages } = result;
  const pageHref = (target: number) => `/customer/orders?organizationId=${encodeURIComponent(organizationId)}&page=${target}`;
  const requestHeaders = await headers();
  const contentChanges = new Map<string, Awaited<ReturnType<typeof listContentChangesForCustomer>>>();
  await Promise.all(orders.flatMap((order) => order.items.map(async (item) => {
    try { contentChanges.set(item.id, await listContentChangesForCustomer(requestHeaders, organizationId, item.id)); }
    catch { contentChanges.set(item.id, []); }
  })));
  const offerRows = await listCustomerEquivalentOffers(requestHeaders, organizationId, orders.flatMap((order) => order.items.map((item) => item.id))).catch(() => []);
  const offersByItem = new Map<string, typeof offerRows>();
  for (const offer of offerRows) offersByItem.set(offer.orderItemId, [...(offersByItem.get(offer.orderItemId) ?? []), offer]);

  return (
    <>
      <div className={styles.headingRow}>
        <div>
          <h1 className={styles.title}>Orders</h1>
          <p className={styles.subtitle}>Follow each placement through review and publication. Updates include a next-update date when one is set.</p>
        </div>
      </div>
      {params.placed && <div className={styles.banner}><strong>Your order is in.</strong> We’ll keep you updated as each placement moves forward.</div>}
      {params.writingUpdated && <div className={styles.banner}>Your writing decision was saved.</div>}
      {params.writingError && <div className={styles.error}>That writing action is no longer available. Refresh the order and review its current draft status.</div>}
      {params.cancellationRequested && <div className={styles.banner}>Your cancellation request was submitted for review.</div>}
      {params.cancellationUpdated && <div className={styles.banner}>The cancellation decision was saved. Check the item for its status and any wallet credit.</div>}
      {params.cancellationError && <div className={styles.error}>That cancellation action is no longer available. Refresh the order and review its current status.</div>}
      {params.changeSubmitted && <div className={styles.banner}>Your content change request was sent for review.</div>}
      {params.changeConsented && <div className={styles.banner}>Your content sharing approval was saved. GPHKM will prepare the updated placement instructions.</div>}
      {params.changeError && <div className={styles.error}>That content change is no longer available. Refresh the order and review its current status.</div>}
      {params.equivalentUpdated === "accepted" && <div className={styles.banner}>Your approval and content-sharing consent were recorded. GPHKM is preparing the placement with the same order price.</div>}
      {params.equivalentUpdated === "declined" && <div className={styles.banner}>Your decision was recorded. Review the linked Support request for next steps.</div>}
      {params.equivalentError && <div className={styles.error}>That placement option is no longer available. Refresh the order or contact Support.</div>}
      <nav aria-label="Order pages">
        {page > 1 && <Link href={pageHref(page - 1)}>Previous page</Link>}{" "}
        <span>Page {page} of {totalPages}</span>{" "}
        {page < totalPages && <Link href={pageHref(page + 1)}>Next page</Link>}
      </nav>
      {!orders.length ? (
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>No orders yet</h2>
          <p className={styles.panelText}>Orders you place from the marketplace will appear here.</p>
        </section>
      ) : <div className="customerOrders">
        {orders.map((order) => (
          <article className="customerOrder" key={order.id}>
            <header className="customerOrderHeader">
              <div><p>Order {order.id.slice(0, 8)}</p><h2>{label(order.status)}</h2></div>
              <div><time dateTime={order.createdAt}>{new Date(order.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</time><strong>{dollars(order.totalMinor)}</strong></div>
            </header>
            <p className="customerOrderNote">GPHKM will share the approved article or brief, destination URL, anchor text, and placement instructions with the publication partner for fulfillment. Supplier contact details stay private.</p>
            <div className="customerOrderItems">
              {order.items.map((item) => {
                const title = typeof item.listing.title === "string" ? item.listing.title : "Website placement";
                const lastUpdatedAt = item.lastUpdatedAt ?? order.createdAt;
                const changes = contentChanges.get(item.id) ?? [];
                // The server returns requests newest-first. Use that ordering
                // when selecting the active request and the latest consented
                // version so an old rejection cannot mask newer approval.
                const latestChange = changes[0];
                const latestConsented = changes.find((change) => change.status === "CONSENTED")?.approvedContent ?? null;
                const pendingConsent = latestChange?.status === "APPROVED_AWAITING_CONSENT" && latestChange.approvedContent
                  ? { requestId: latestChange.id, content: latestChange.approvedContent } : null;
                const canRequestChange = !pendingConsent && latestChange?.status !== "REQUESTED"
                  && !["IN_PROGRESS", "LINK_VERIFICATION", "COMPLETE", "RESOLVED"].includes(item.status);
                return (
                  <section className="customerOrderItem" key={item.id}>
                    <div className="customerOrderItemTop"><div><h3>{title}</h3><span>{label(item.status)}</span></div><strong>{dollars((BigInt(item.placementPriceMinor) + BigInt(item.writingPriceMinor)).toString())}</strong></div>
                    <p><b>Last updated:</b> <time dateTime={lastUpdatedAt}>{new Date(lastUpdatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</time></p>
                    <p><b>Next update:</b> {item.nextUpdateAt ? <time dateTime={item.nextUpdateAt}>{new Date(item.nextUpdateAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}</time> : "To be scheduled"}</p>
                    {item.milestoneHistory.length > 0 && <section aria-label="Placement update history"><h4>Placement updates</h4><ol>{[...item.milestoneHistory].reverse().map((milestone, index) => <li key={`${milestone.occurredAt}-${index}`}>
                      <strong>{label(milestone.status)}</strong> <time dateTime={milestone.occurredAt}>{new Date(milestone.occurredAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</time>
                      {milestone.nextUpdateAt && <span> · Next update by {new Date(milestone.nextUpdateAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}</span>}
                    </li>)}</ol></section>}
                    {item.publicationUrls.length > 0 && <div><b>Live publication:</b><ul>{item.publicationUrls.map((url, index) => <li key={`${index}-${url}`}><a href={url} target="_blank" rel="noopener noreferrer">View live publication{item.publicationUrls.length > 1 ? ` ${index + 1}` : ""}</a></li>)}</ul><p><b>Google indexing:</b> {item.googleIndexingStatus === "UNKNOWN" ? "Unknown — GPHKM does not currently verify indexing." : "Not available"}</p></div>}
                    <p><b>Destination:</b> <span className="customerOrderText">{latestConsented?.targetUrl ?? item.targetUrl}</span></p>
                    <p><b>Anchor text:</b> <span className="customerOrderText">{latestConsented?.anchorText ?? item.anchorText}</span></p>
                    {(latestConsented?.instructions ?? item.instructions) && <p><b>Publication instructions:</b> <span className="customerOrderText">{latestConsented?.instructions ?? item.instructions}</span></p>}
                    {item.writingSelected && <section className="customerWritingReview">
                      <h4>GPHKM Writing</h4>
                      {!item.writingWorkflow && <p>This writing item is visible to the person who placed the order.</p>}
                      {item.writingWorkflow?.state === "WAITING_FOR_FIRST_DRAFT" && <p>Your brief is being prepared. The publication instructions will wait until you approve the article.</p>}
                      {item.writingWorkflow?.state === "FIRST_DRAFT_READY" && <>
                        <p>Review the complete first draft. Approving it completes the writing service. You may request one included revision instead.</p>
                        <pre>{item.writingWorkflow.firstDraftText}</pre>
                        <form action={updateCustomerWritingAction}>
                          <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="command" value="APPROVE" />
                          <button type="submit">Approve this draft</button>
                        </form>
                        <form action={updateCustomerWritingAction}>
                          <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="command" value="REQUEST_REVISION" />
                          <label>One included revision request<textarea name="revisionText" required maxLength={2000} rows={4} /></label>
                          <button type="submit">Request one revision</button>
                        </form>
                      </>}
                      {item.writingWorkflow?.state === "REVISION_REQUESTED" && <><p>Your revision request was sent. We’re preparing the final draft.</p><h5>First draft</h5><pre>{item.writingWorkflow.firstDraftText}</pre><p><b>Your request:</b> {item.writingWorkflow.revisionRequestText}</p></>}
                      {item.writingWorkflow?.state === "FINAL_DRAFT_READY" && <>
                        <p>Review the final draft. Approving completes the writing service. If you decline it, GPHKM will credit the undelivered final writing stage to your organization wallet and hold the placement until you submit an article of your own.</p><pre>{item.writingWorkflow.finalDraftText}</pre>
                        <form action={updateCustomerWritingAction}>
                          <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="command" value="APPROVE" />
                          <button type="submit">Approve final draft</button>
                        </form>
                        <form action={updateCustomerWritingAction}>
                          <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="command" value="DECLINE_FINAL" />
                          <button type="submit">Stop writing and submit my own article</button>
                        </form>
                      </>}
                      {item.writingWorkflow?.state === "CUSTOMER_DECLINED_FINAL" && <p>Writing has stopped. {BigInt(item.writingWorkflow.writingRefundMinor) > 0n ? `${dollars(item.writingWorkflow.writingRefundMinor)} was credited to your organization wallet for the undelivered final writing stage.` : "There was no final-stage amount to credit."} Your placement remains active and is waiting for your article to be reviewed and approved for sharing.</p>}
                      {(item.writingWorkflow?.state === "APPROVED_FIRST" || item.writingWorkflow?.state === "APPROVED_FINAL") && <><p>Article approved. GPHKM can now prepare the placement instructions.</p><pre>{item.writingWorkflow.approvedArticleText}</pre></>}
                    </section>}
                    <details><summary>{item.writingSelected ? "View writing brief" : "View submitted article"}</summary><pre>{item.writingSelected ? item.writingBrief : item.articleText}</pre></details>
                    <p><Link href={`/customer/support?organizationId=${encodeURIComponent(organizationId)}&itemId=${item.id}`}>Ask about this placement</Link></p>
                    {(offersByItem.get(item.id) ?? []).map((offer) => <EquivalentOfferCard key={offer.id} offer={offer} organizationId={organizationId} />)}
                    <OrderItemCancellationForm organizationId={organizationId} itemId={item.id} />
                    <ContentChangeForm organizationId={organizationId} itemId={item.id} writingSelected={item.writingSelected} writingStopped={item.writingWorkflow?.state === "CUSTOMER_DECLINED_FINAL"}
                      targetUrl={latestConsented?.targetUrl ?? item.targetUrl} anchorText={latestConsented?.anchorText ?? item.anchorText}
                      articleText={latestConsented?.articleText ?? item.articleText} canRequest={canRequestChange} approvedChange={pendingConsent} />
                  </section>
                );
              })}
            </div>
          </article>
        ))}
      </div>}
    </>
  );
}
