import Link from "next/link";
import { listPreHandoffCancellationRequests } from "@/server/orders/cancellation";
import { decidePreHandoffCancellationAction } from "./cancellation-actions";
import styles from "@/components/support.module.css";

export async function PreHandoffCancellationQueue(props: { headers: Headers; page?: string; supportPage?: number }) {
  const result = await listPreHandoffCancellationRequests(props.headers, props.page);
  return (
    <section aria-labelledby="cancellation-review-title">
      <h2 id="cancellation-review-title">Pre-handoff cancellation requests · {result.total} awaiting review</h2>
      {!result.rows.length ? <p>No cancellation requests are waiting for review.</p> : result.rows.map((row) => (
        <article key={row.id}>
          <h3>Order item {row.orderItemId.slice(0, 8)}</h3>
          <p>Order {row.orderId.slice(0, 8)} · Organization {row.organizationId.slice(0, 8)}</p>
          <p>{row.reason}</p>
          <form action={decidePreHandoffCancellationAction}>
            <input type="hidden" name="requestId" value={row.id} />
            <input type="hidden" name="cancellationPage" value={result.page} />
            <input type="hidden" name="supportPage" value={props.supportPage ?? 1} />
            <label>
              Decision reason
              <textarea name="decisionReason" required minLength={5} maxLength={1000} rows={2} />
            </label>
            <button type="submit" name="decision" value="APPROVED">Approve eligible refund</button>
            <button type="submit" name="decision" value="DENIED">Deny request</button>
          </form>
        </article>
      ))}
      {result.totalPages > 1 && <nav className={styles.pagination} aria-label="Cancellation request pages">{result.page > 1 ? <Link href={`/staff/support?cancellationPage=${result.page - 1}&page=${props.supportPage ?? 1}`}>Previous</Link> : <span /> }<span>Page {result.page} of {result.totalPages}</span>{result.page < result.totalPages ? <Link href={`/staff/support?cancellationPage=${result.page + 1}&page=${props.supportPage ?? 1}`}>Next</Link> : <span />}</nav>}
    </section>
  );
}
