import { randomUUID } from "node:crypto";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { listPacketCandidates } from "@/server/fulfillment/packets";
import { logSafeFailure } from "@/server/observability/safe-log";
import { preparePacketsAction, requestRecipientReconsentAction } from "../actions";
import styles from "../packets.module.css";

export const dynamic = "force-dynamic";
export default async function NewPacketPage({ searchParams }: { searchParams: Promise<{ orderId?: string; error?: string; consentRequested?: string }> }) {
  const query = await searchParams;
  if (!query.orderId) notFound();
  let rows: Awaited<ReturnType<typeof listPacketCandidates>>;
  try {
    rows = await listPacketCandidates(await headers(), query.orderId);
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden", "Order unavailable"].includes(error.message)) notFound();
    const requestId = randomUUID();
    logSafeFailure("supplier_packet_candidates_load_failed", error, requestId);
    return <main className={styles.page}>
      <header className={styles.head}><div><p className={styles.eyebrow}>SUPPLIER HANDOFF</p><h1>Prepare packets</h1><p className={styles.muted}>Packet readiness could not be checked.</p></div><Link className={styles.link} href="/staff/fulfillment">Back to fulfillment</Link></header>
      <section className={styles.panel}>
        <h2>Could not load this order</h2>
        <p className={styles.warning} role="alert">No packet was prepared or sent. Try loading this page again.</p>
        <p className={styles.muted}>If the problem continues, share reference {requestId} with your system administrator.</p>
        <div className={styles.actions}><Link href={`/staff/fulfillment/packets/new?orderId=${encodeURIComponent(query.orderId)}`}>Retry</Link></div>
      </section>
    </main>;
  }
  const eligibleCount = rows.filter((row) => row.eligible).length;
  return <main className={styles.page}>
    <header className={styles.head}><div><p className={styles.eyebrow}>SUPPLIER HANDOFF</p><h1>Prepare packets</h1><p className={styles.muted}>Select only ready, assigned items. GPHKM groups selected items by fulfillment partner and creates a separate immutable packet for each.</p></div><Link className={styles.link} href="/staff/fulfillment">Back to fulfillment</Link></header>
    {query.error ? <p className={styles.warning} role="alert">{query.error === "recipient-consent"
      ? "The orderer approval request could not be recorded. Refresh and confirm the delivery review is still eligible."
      : "The selected items could not be prepared. Check their assignment, consent, article readiness, and status."}</p> : null}
    {query.consentRequested ? <p className={styles.warning} role="status">The orderer can now review the unchanged placement details and approve sharing them with the current fulfillment contact. Ask the person who placed this order to open Customer → Orders. No packet was sent, and the order remains Preparing.</p> : null}
    <form action={preparePacketsAction} className={styles.panel}>
      <input type="hidden" name="orderId" value={query.orderId} />
      <p className={styles.muted}>{eligibleCount} of {rows.length} items are ready for a supplier packet. Items need an Admin assignment, customer consent, and publication-ready content.</p>
      <div className={styles.items}>{rows.map((row) => <label className={styles.item} key={row.orderItemId}>
        <span className={styles.checks}><input type="checkbox" name="itemIds" value={row.orderItemId} disabled={!row.eligible} required={false} />
          <span><strong>{row.listingTitle}</strong><br /><span className={styles.muted}>Item {row.orderItemId.slice(0, 8)} · {row.state.replaceAll("_", " ")}</span><br />{row.eligible ? "Ready for packet preparation" : row.blockReason ?? "Not available to this Admin"}</span>
        </span>
      </label>)}</div>
      <button className={styles.submit} type="submit" disabled={eligibleCount === 0}>Prepare selected supplier packets</button>
    </form>
    {rows.filter((row) => row.requestReconsent).map((row) => <section className={styles.panel} key={`reconsent-${row.orderItemId}`}>
      <h2>Orderer approval needed · {row.listingTitle}</h2>
      <p className={styles.muted}>The previous send was confirmed not delivered. GPHKM will keep the original cutoff and Preparing status. The orderer must review the exact unchanged placement content before a replacement can be prepared.</p>
      <form action={requestRecipientReconsentAction} className={styles.actions}>
        <input type="hidden" name="orderId" value={query.orderId} />
        <input type="hidden" name="itemId" value={row.orderItemId} />
        <button className={styles.submit} type="submit">Request orderer approval</button>
      </form>
    </section>)}
  </main>;
}
