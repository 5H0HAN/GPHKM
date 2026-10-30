import Link from "next/link";
import { headers } from "next/headers";
import { listSupplierPacketReconciliation } from "@/server/fulfillment/packets";
import styles from "../packets.module.css";

export const dynamic = "force-dynamic";
const labels: Record<string, string> = { MANUAL_SEND_PENDING: "Manual handoff reserved - record send or reconcile as unsent", UNKNOWN_OUTCOME: "Unknown send result - reconcile before resend", STUCK_SEND_REVIEW: "Send attempt stuck over 10 minutes - review before resend", DELIVERY_ISSUE: "Delivery issue or bounce", DELIVERY_FOLLOW_UP_72H: "Accepted, delivery unconfirmed after 72 hours", SUPPLIER_ACKNOWLEDGEMENT_FOLLOW_UP_72H: "Supplier acknowledgement overdue by 72 hours", PACKET_ORDER_STATE_MISMATCH: "Packet and order state mismatch", MANUAL_EXPORT_NO_SEND: "Latest manual export has no later send record" };
export default async function PacketReconciliationPage({ searchParams }: { searchParams: Promise<{ attemptsPage?: string | string[]; eventsPage?: string | string[]; itemsPage?: string | string[]; heldPage?: string | string[] }> }) {
  const query = await searchParams;
  const pageParam = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const data = await listSupplierPacketReconciliation(await headers(), {
    attempts: pageParam(query.attemptsPage), events: pageParam(query.eventsPage),
    items: pageParam(query.itemsPage), held: pageParam(query.heldPage),
  });
  const queueHref = (key: "attemptsPage" | "eventsPage" | "itemsPage" | "heldPage", page: number) => {
    const params = new URLSearchParams();
    params.set("attemptsPage", String(key === "attemptsPage" ? page : data.attemptsPagination.page));
    params.set("eventsPage", String(key === "eventsPage" ? page : data.unmatchedEventsPagination.page));
    params.set("itemsPage", String(key === "itemsPage" ? page : data.unpacketItemsPagination.page));
    params.set("heldPage", String(key === "heldPage" ? page : data.heldPacketsPagination.page));
    return `/staff/fulfillment/packets/reconciliation?${params.toString()}`;
  };
  const pagination = (label: string, key: "attemptsPage" | "eventsPage" | "itemsPage" | "heldPage", page: number, totalPages: number, total: number) => <nav className={styles.pagination} aria-label={label}>
    {page > 1 && <Link className={styles.link} href={queueHref(key, page - 1)}>Previous page</Link>}
    <span>Page {page} of {totalPages} · {total} records</span>
    {page < totalPages && <Link className={styles.link} href={queueHref(key, page + 1)}>Next page</Link>}
  </nav>;
  return <main className={styles.page}>
    <header className={styles.head}><div><p className={styles.eyebrow}>SUPPLIER HANDOFF</p><h1>Packet reconciliation</h1><p className={styles.muted}>Review unknown outcomes immediately, sends stuck for more than 10 minutes, delivery issues, overdue delivery and acknowledgement follow-ups, and state mismatches. The 72-hour periods are internal follow-up targets, not supplier SLAs. Each queue is paginated; no article or recipient content appears here.</p></div><Link className={styles.link} href="/staff/fulfillment">Back to fulfillment</Link></header>
    <section className={styles.panel}><h2>Needs review</h2>{pagination("Packet attempt pages", "attemptsPage", data.attemptsPagination.page, data.attemptsPagination.totalPages, data.attemptsPagination.total)}{data.attempts.length ? <table className={styles.table}><thead><tr><th>Reason</th><th>Order</th><th>Packet</th><th>Attempt state</th><th>Provider ref</th><th>Updated</th><th /></tr></thead><tbody>{data.attempts.map((row) => <tr key={row.attemptId}><td>{labels[row.reason] ?? row.reason}</td><td>{row.orderReference}</td><td>{row.packetId}</td><td>{row.state}</td><td>{row.providerReference ?? "—"}</td><td>{(row.deliveredAt ?? row.acceptedAt ?? row.createdAt).toLocaleString()}</td><td><Link className={styles.link} href={`/staff/fulfillment/packets/${encodeURIComponent(row.packetId)}`}>Review</Link></td></tr>)}</tbody></table> : <p className={styles.muted}>{data.attemptsPagination.total ? "No actionable attempts on this page. Continue through candidate pages to review older attempts." : "No packet attempts need reconciliation."}</p>}</section>
    {data.heldPacketsPagination.total > 0 ? <section className={styles.panel}><h2>Packets held for staff review</h2>{pagination("Held packet pages", "heldPage", data.heldPacketsPagination.page, data.heldPacketsPagination.totalPages, data.heldPacketsPagination.total)}{data.heldPackets.length ? <table className={styles.table}><thead><tr><th>Order</th><th>Packet</th><th>Hold reason</th><th>Updated</th><th /></tr></thead><tbody>{data.heldPackets.map((row) => <tr key={row.packetId}><td>{row.orderReference}</td><td>{row.packetId}</td><td>{row.holdReason}</td><td>{row.updatedAt?.toLocaleString() ?? "Not recorded"}</td><td><Link className={styles.link} href={`/staff/fulfillment/packets/${encodeURIComponent(row.packetId)}`}>Review</Link></td></tr>)}</tbody></table> : <p className={styles.muted}>No packets on this page are assigned to your queue.</p>}</section> : null}
    {data.unpacketItemsPagination.total > 0 ? <section className={styles.panel}><h2>Ready for handoff without a packet</h2>{pagination("Unpacket item pages", "itemsPage", data.unpacketItemsPagination.page, data.unpacketItemsPagination.totalPages, data.unpacketItemsPagination.total)}{data.unpacketItems.length ? <table className={styles.table}><thead><tr><th>Order</th><th>Order item</th><th>Updated</th><th /></tr></thead><tbody>{data.unpacketItems.map((row) => <tr key={row.itemId}><td>{row.orderReference}</td><td>{row.itemId}</td><td>{row.updatedAt.toLocaleString()}</td><td><Link className={styles.link} href={`/staff/fulfillment/${encodeURIComponent(row.itemId)}`}>Review item</Link></td></tr>)}</tbody></table> : <p className={styles.muted}>No eligible unpacket items on this page.</p>}</section> : null}
    {data.unmatchedEventsPagination.total > 0 ? <section className={styles.panel}><h2>Provider events requiring reconciliation</h2>{pagination("Provider event pages", "eventsPage", data.unmatchedEventsPagination.page, data.unmatchedEventsPagination.totalPages, data.unmatchedEventsPagination.total)}{data.unmatchedEvents.length ? <table className={styles.table}><thead><tr><th>Event</th><th>Provider event ID</th><th>Type</th><th>State</th><th>Received</th><th>Packet</th></tr></thead><tbody>{data.unmatchedEvents.map((row) => <tr key={row.eventId}><td>{row.eventId}</td><td>{row.providerEventId}</td><td>{row.eventType}</td><td>{row.state}</td><td>{row.receivedAt.toLocaleString()}</td><td>{row.packetId ? <Link className={styles.link} href={`/staff/fulfillment/packets/${encodeURIComponent(row.packetId)}`}>Review packet</Link> : "Unmatched · Super Admin"}</td></tr>)}</tbody></table> : <p className={styles.muted}>No events on this page are assigned to your queue.</p>}</section> : null}
  </main>;
}
