import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { listPacketCandidates } from "@/server/fulfillment/packets";
import { preparePacketsAction } from "../actions";
import styles from "../packets.module.css";

export const dynamic = "force-dynamic";
export default async function NewPacketPage({ searchParams }: { searchParams: Promise<{ orderId?: string; error?: string }> }) {
  const query = await searchParams;
  if (!query.orderId) notFound();
  let rows;
  try { rows = await listPacketCandidates(await headers(), query.orderId); } catch { notFound(); }
  const eligibleCount = rows.filter((row) => row.eligible).length;
  return <main className={styles.page}>
    <header className={styles.head}><div><p className={styles.eyebrow}>SUPPLIER HANDOFF</p><h1>Prepare packets</h1><p className={styles.muted}>Select only ready, assigned items. GPHKM groups selected items by fulfillment partner and creates a separate immutable packet for each.</p></div><Link className={styles.link} href="/staff/fulfillment">Back to fulfillment</Link></header>
    {query.error ? <p className={styles.warning}>The selected items could not be prepared. Check their assignment, consent, article readiness, and status.</p> : null}
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
  </main>;
}
