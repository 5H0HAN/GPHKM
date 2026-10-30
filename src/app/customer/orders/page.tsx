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

const milestones = [
  ["ORDER_RECEIVED", "Order received"],
  ["CONTENT_REVIEW", "Content review"],
  ["PREPARING", "Preparing your placement"],
  ["IN_PROGRESS", "Publication in progress"],
  ["LINK_VERIFICATION", "Link verification"],
  ["COMPLETE", "Complete"],
] as const;

function label(value: string) {
  return value.toLowerCase().split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function milestoneLabel(value: string) {
  return milestones.find(([key]) => key === value)?.[1] ?? (value === "RESOLVED" ? "Resolved" : label(value));
}

function dollars(minor: string) {
  const amount = BigInt(minor);
  return `$${(amount / 100n).toLocaleString("en-US")}.${(amount % 100n).toString().padStart(2, "0")}`;
}

function date(value: string, withTime = false) {
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" as const, timeZone: "UTC" } : { timeZone: "UTC" }),
  });
}

function feedbackMessage(params: { placed?: string; writingUpdated?: string; writingError?: string; cancellationRequested?: string; cancellationError?: string; cancellationUpdated?: string; changeSubmitted?: string; changeConsented?: string; changeError?: string; equivalentUpdated?: string; equivalentError?: string }) {
  if (params.placed) return { kind: "success", text: "Your order is in. We’ll keep you updated as each placement moves forward." };
  if (params.writingUpdated) return { kind: "success", text: "Your writing decision was saved." };
  if (params.cancellationRequested) return { kind: "success", text: "Your cancellation request was sent for review." };
  if (params.cancellationUpdated) return { kind: "success", text: "The cancellation decision was saved. Check the placement for its latest status and any wallet credit." };
  if (params.changeSubmitted) return { kind: "success", text: "Your content change request was sent for review." };
  if (params.changeConsented) return { kind: "success", text: "Your approval was saved. GPHKM will prepare the updated placement instructions." };
  if (params.equivalentUpdated === "accepted") return { kind: "success", text: "Your approval was recorded at the same order price. GPHKM is preparing the placement." };
  if (params.equivalentUpdated === "declined") return { kind: "success", text: "Your decision was recorded. Check your Support request for next steps." };
  if (params.writingError) return { kind: "error", text: "That writing action is no longer available. Refresh the order and review the current draft." };
  if (params.cancellationError) return { kind: "error", text: "That cancellation action is no longer available. Refresh the order and review its current status." };
  if (params.changeError) return { kind: "error", text: "That content change is no longer available. Refresh the order and review its current status." };
  if (params.equivalentError) return { kind: "error", text: "That placement option is no longer available. Refresh the order or contact Support." };
  return null;
}

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ organizationId?: string | string[]; page?: string | string[]; placed?: string; writingUpdated?: string; writingError?: string; cancellationRequested?: string; cancellationError?: string; cancellationUpdated?: string; changeSubmitted?: string; changeConsented?: string; changeError?: string; equivalentUpdated?: string; equivalentError?: string }> }) {
  const workspace = await loadCustomerWorkspace();
  if (!workspace.authenticated) return null;
  const params = await searchParams;
  const organizationId = selectedOrganizationId(workspace.organizations, Array.isArray(params.organizationId) ? params.organizationId[0] : params.organizationId);
  if (!organizationId) return <div className={styles.error}>An organization is required to view orders.</div>;

  let result;
  try {
    result = await getMyOrdersPage(await headers(), organizationId, params.page);
  } catch {
    return <div className={styles.error} role="alert">Order details could not be loaded. Refresh or contact Support if this continues.</div>;
  }

  const { orders, page, totalPages } = result;
  const pageHref = (target: number) => `/customer/orders?organizationId=${encodeURIComponent(organizationId)}&page=${target}`;
  const requestHeaders = await headers();
  const itemIds = orders.flatMap((order) => order.items.map((item) => item.id));
  const contentChanges = new Map<string, Awaited<ReturnType<typeof listContentChangesForCustomer>>>();
  await Promise.all(orders.flatMap((order) => order.items.map(async (item) => {
    try { contentChanges.set(item.id, await listContentChangesForCustomer(requestHeaders, organizationId, item.id)); }
    catch { contentChanges.set(item.id, []); }
  })));
  const offerRows = await listCustomerEquivalentOffers(requestHeaders, organizationId, itemIds).catch(() => []);
  const offersByItem = new Map<string, typeof offerRows>();
  for (const offer of offerRows) offersByItem.set(offer.orderItemId, [...(offersByItem.get(offer.orderItemId) ?? []), offer]);
  const feedback = feedbackMessage(params);
  const placementCount = orders.reduce((count, order) => count + order.items.length, 0);

  return <div className={styles.ordersPage}>
    <header className={styles.ordersHeading}>
      <div>
        <h1>Orders</h1>
        <p>Track each placement, see what needs your attention, and follow the next update.</p>
      </div>
      <Link className={styles.ordersBrowseLink} href={`/customer/catalog?organizationId=${encodeURIComponent(organizationId)}`}>Browse marketplace</Link>
    </header>

    {feedback && <p className={feedback.kind === "error" ? styles.ordersError : styles.ordersNotice} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}

    {orders.length > 0 && <div className={styles.ordersContext}>
      <span>{placementCount} placement{placementCount === 1 ? "" : "s"} across {orders.length} order{orders.length === 1 ? "" : "s"} on this page</span>
      <span>Times are shown in UTC.</span>
    </div>}

    {!orders.length ? <section className={styles.ordersEmpty}>
      <span className={styles.ordersEmptyMark} aria-hidden="true">G</span>
      <h2>Your order history starts here</h2>
      <p>When you place a website placement, its progress and updates will appear on this page.</p>
      <Link className={styles.ordersPrimaryLink} href={`/customer/catalog?organizationId=${encodeURIComponent(organizationId)}`}>Explore the marketplace</Link>
    </section> : <div className={styles.ordersList}>
      {orders.map((order) => <article className={styles.orderCard} key={order.id}>
        <header className={styles.orderCardHeader}>
          <div>
            <h2 className={styles.orderCardTitle}>Order <span>#{order.id.slice(0, 8).toUpperCase()}</span></h2>
            {order.items.length > 1 && <p className={styles.orderOverallStatus}>Overall progress: {milestoneLabel(order.status)}</p>}
            <p className={styles.orderDate}>Placed <time dateTime={order.createdAt}>{date(order.createdAt)}</time> <span aria-hidden="true">·</span> {order.items.length} placement{order.items.length === 1 ? "" : "s"}</p>
          </div>
          <div className={styles.orderTotal}><span>Order total</span><strong>{dollars(order.totalMinor)}</strong></div>
        </header>

        <div className={styles.placementList}>
          {order.items.map((item) => {
            const title = typeof item.listing.title === "string" ? item.listing.title : "Website placement";
            const lastUpdatedAt = item.lastUpdatedAt ?? order.createdAt;
            const changes = contentChanges.get(item.id) ?? [];
            const latestChange = changes[0];
            const latestConsented = changes.find((change) => change.status === "CONSENTED")?.approvedContent ?? null;
            const pendingConsent = latestChange?.status === "APPROVED_AWAITING_CONSENT" && latestChange.approvedContent
              ? { requestId: latestChange.id, content: latestChange.approvedContent } : null;
            const canRequestChange = order.isOrderer && !pendingConsent && latestChange?.status !== "REQUESTED"
              && !["IN_PROGRESS", "LINK_VERIFICATION", "COMPLETE", "RESOLVED"].includes(item.status);
            const currentIndex = milestones.findIndex(([key]) => key === item.status);
            const terminal = item.status === "COMPLETE" || item.status === "RESOLVED";
            const writingNeedsReview = item.writingWorkflow?.state === "FIRST_DRAFT_READY" || item.writingWorkflow?.state === "FINAL_DRAFT_READY";

            return <section className={styles.placementCard} key={item.id} aria-labelledby={`placement-${item.id}`}>
              <div className={styles.placementHeader}>
                <div className={styles.placementName}>
                  <span className={styles.placementMark} aria-hidden="true">↗</span>
                  <div><h3 id={`placement-${item.id}`}>{title}</h3><span className={terminal ? styles.statusComplete : styles.statusActive}>{milestoneLabel(item.status)}</span></div>
                </div>
                <strong className={styles.placementPrice}>{dollars((BigInt(item.placementPriceMinor) + BigInt(item.writingPriceMinor)).toString())}</strong>
              </div>

              {!terminal && <ol className={styles.progressTrack} aria-label={`Progress for ${title}`}>
                {milestones.map(([key, milestone], index) => {
                  const reached = currentIndex >= 0 && index <= currentIndex;
                  const current = key === item.status;
                  return <li key={key} className={`${reached ? styles.progressReached : ""} ${current ? styles.progressCurrent : ""}`} aria-current={current ? "step" : undefined}>
                    <span className={styles.progressDot} aria-hidden="true" />
                    <span>{milestone}</span>
                  </li>;
                })}
              </ol>}
              {terminal && <p className={styles.completeNote}>{item.status === "RESOLVED" ? "This placement has been resolved." : "This placement is complete."}</p>}

              <div className={styles.updateRow}>
                <p><span>Last updated</span><time dateTime={lastUpdatedAt}>{date(lastUpdatedAt, true)} UTC</time></p>
                <p><span>Next update</span>{item.nextUpdateAt ? <time dateTime={item.nextUpdateAt}>{date(item.nextUpdateAt)}</time> : <span className={styles.pendingDate}>To be scheduled</span>}</p>
              </div>

              <div className={styles.placementActions}>
                <Link href={`/customer/support?organizationId=${encodeURIComponent(organizationId)}&itemId=${item.id}`}>Ask about this placement</Link>
                {writingNeedsReview && <a href={`#writing-${item.id}`}>Review your draft</a>}
              </div>

              <details className={styles.orderDetails}>
                <summary>Placement details and updates</summary>
                <div className={styles.detailsBody}>
                  {item.milestoneHistory.length > 0 && <section className={styles.historyBlock} aria-label="Placement update history">
                    <h4>Progress history</h4>
                    <ol>{[...item.milestoneHistory].reverse().map((milestone, index) => <li key={`${milestone.occurredAt}-${index}`}>
                      <strong>{milestoneLabel(milestone.status)}</strong>
                      <time dateTime={milestone.occurredAt}>{date(milestone.occurredAt, true)} UTC</time>
                      {milestone.nextUpdateAt && <span>Next update by {date(milestone.nextUpdateAt)}</span>}
                    </li>)}</ol>
                  </section>}
                  <dl className={styles.placementFacts}>
                    <div><dt>Destination URL</dt><dd className={styles.customerOrderText}>{latestConsented?.targetUrl ?? item.targetUrl}</dd></div>
                    <div><dt>Anchor text</dt><dd>{latestConsented?.anchorText ?? item.anchorText}</dd></div>
                    {(latestConsented?.instructions ?? item.instructions) && <div><dt>Publication instructions</dt><dd>{latestConsented?.instructions ?? item.instructions}</dd></div>}
                  </dl>
                  {item.publicationUrls.length > 0 && <section className={styles.liveLinks}>
                    <h4>Published link</h4>
                    <ul>{item.publicationUrls.map((url, index) => <li key={`${index}-${url}`}><a href={url} target="_blank" rel="noopener noreferrer">Open live publication{item.publicationUrls.length > 1 ? ` ${index + 1}` : ""}</a></li>)}</ul>
                    <p>Google indexing: {item.googleIndexingStatus === "UNKNOWN" ? "Unknown. GPHKM does not currently verify indexing." : "Not available."}</p>
                  </section>}
                  <details className={styles.subDetails}>
                    <summary>{item.writingSelected ? "View writing brief" : "View submitted article"}</summary>
                    <pre>{item.writingSelected ? item.writingBrief : item.articleText}</pre>
                  </details>
                </div>
              </details>

              {item.writingSelected && <details className={styles.writingPanel} id={`writing-${item.id}`} open={writingNeedsReview}>
                <summary>{writingNeedsReview ? "Your review is needed: GPHKM Writing" : "GPHKM Writing"}</summary>
                <div className={styles.detailsBody}>
                  {!item.writingWorkflow && <p>This writing item is visible to the person who placed the order.</p>}
                  {item.writingWorkflow?.state === "WAITING_FOR_FIRST_DRAFT" && <p>Your brief is being prepared. Placement instructions will wait until you approve the article.</p>}
                  {item.writingWorkflow?.state === "FIRST_DRAFT_READY" && <>
                    <p>Review the complete first draft. Approving it completes the writing service, or you can request the included revision.</p>
                    <pre>{item.writingWorkflow.firstDraftText}</pre>
                    <div className={styles.writingActions}>
                      <form action={updateCustomerWritingAction}>
                        <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="command" value="APPROVE" />
                        <button type="submit">Approve this draft</button>
                      </form>
                      <form action={updateCustomerWritingAction}>
                        <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="command" value="REQUEST_REVISION" />
                        <label>One included revision request<textarea name="revisionText" required maxLength={2000} rows={4} /></label>
                        <button type="submit">Request one revision</button>
                      </form>
                    </div>
                  </>}
                  {item.writingWorkflow?.state === "REVISION_REQUESTED" && <><p>Your revision request was sent. We’re preparing the final draft.</p><h4>First draft</h4><pre>{item.writingWorkflow.firstDraftText}</pre><p><strong>Your request:</strong> {item.writingWorkflow.revisionRequestText}</p></>}
                  {item.writingWorkflow?.state === "FINAL_DRAFT_READY" && <>
                    <p>Approving completes the writing service. If you decline, the undelivered final writing stage is credited to your organization wallet and the placement waits for your article.</p><pre>{item.writingWorkflow.finalDraftText}</pre>
                    <div className={styles.writingActions}>
                      <form action={updateCustomerWritingAction}>
                        <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="command" value="APPROVE" />
                        <button type="submit">Approve final draft</button>
                      </form>
                      <form action={updateCustomerWritingAction}>
                        <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="command" value="DECLINE_FINAL" />
                        <button type="submit">Stop writing and submit my own article</button>
                      </form>
                    </div>
                  </>}
                  {item.writingWorkflow?.state === "CUSTOMER_DECLINED_FINAL" && <p>Writing has stopped. {BigInt(item.writingWorkflow.writingRefundMinor) > 0n ? `${dollars(item.writingWorkflow.writingRefundMinor)} was credited to your organization wallet for the undelivered final writing stage.` : "There was no final-stage amount to credit."} Your placement is waiting for your article to be reviewed.</p>}
                  {(item.writingWorkflow?.state === "APPROVED_FIRST" || item.writingWorkflow?.state === "APPROVED_FINAL") && <><p>Article approved. GPHKM can now prepare the placement instructions.</p><pre>{item.writingWorkflow.approvedArticleText}</pre></>}
                </div>
              </details>}

              {(offersByItem.get(item.id) ?? []).map((offer) => <EquivalentOfferCard key={offer.id} offer={offer} organizationId={organizationId} />)}

              <details className={styles.moreActions}>
                <summary>More order actions</summary>
                <div className={styles.detailsBody}>
                  <OrderItemCancellationForm organizationId={organizationId} itemId={item.id} />
                  <ContentChangeForm organizationId={organizationId} itemId={item.id} canAct={order.isOrderer} writingSelected={item.writingSelected} writingStopped={item.writingWorkflow?.state === "CUSTOMER_DECLINED_FINAL"}
                    targetUrl={latestConsented?.targetUrl ?? item.targetUrl} anchorText={latestConsented?.anchorText ?? item.anchorText}
                    articleText={latestConsented?.articleText ?? item.articleText} canRequest={canRequestChange} approvedChange={pendingConsent} />
                </div>
              </details>
            </section>;
          })}
        </div>
      </article>)}
    </div>}

    {orders.length > 0 && totalPages > 1 && <nav className={styles.ordersPagination} aria-label="Order pages">
      {page > 1 ? <Link href={pageHref(page - 1)}>← Newer orders</Link> : <span />}
      <span>Page {page} of {totalPages}</span>
      {page < totalPages ? <Link href={pageHref(page + 1)}>Older orders →</Link> : <span />}
    </nav>}
  </div>;
}
