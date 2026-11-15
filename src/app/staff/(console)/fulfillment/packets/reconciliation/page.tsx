import Link from "next/link";
import { headers } from "next/headers";
import { listSupplierPacketReconciliation } from "@/server/fulfillment/packets";
import styles from "../packets.module.css";

export const dynamic = "force-dynamic";

const reasonLabels: Record<string, string> = {
  MANUAL_SEND_PENDING: "Manual send reserved — confirm the send or resolve it as unsent",
  UNKNOWN_OUTCOME: "Send result unclear — check the email provider before retrying",
  STUCK_SEND_REVIEW: "Send still in progress — check the provider before resolving",
  DELIVERY_ISSUE: "Email delivery issue — review the provider result",
  DELIVERY_FOLLOW_UP_72H: "Delivery still unconfirmed after 72 hours",
  SUPPLIER_ACKNOWLEDGEMENT_FOLLOW_UP_72H: "Supplier response overdue 72 hours after delivery",
  PACKET_ORDER_STATE_MISMATCH: "Packet and placement statuses do not match",
  MANUAL_EXPORT_NO_SEND: "Latest packet export has no recorded send",
  REVIEW_STATE_CHANGED: "Packet status changed — refresh and review it",
};

const attemptStateLabels: Record<string, string> = {
  SENDING: "Send in progress",
  UNKNOWN: "Outcome unclear",
  ACCEPTED: "Accepted by email provider",
  DELIVERY_ISSUE: "Delivery issue",
  DELIVERED: "Delivered",
  MANUAL_SENT: "Manual send recorded",
  EXPORTED: "Exported; send not recorded",
};

type QueueKey = "attemptsPage" | "eventsPage" | "itemsPage" | "heldPage";

export default async function PacketReconciliationPage({ searchParams }: { searchParams: Promise<{ attemptsPage?: string | string[]; eventsPage?: string | string[]; itemsPage?: string | string[]; heldPage?: string | string[] }> }) {
  const query = await searchParams;
  const pageParam = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const data = await listSupplierPacketReconciliation(await headers(), {
    attempts: pageParam(query.attemptsPage), events: pageParam(query.eventsPage),
    items: pageParam(query.itemsPage), held: pageParam(query.heldPage),
  });
  const queueHref = (key: QueueKey, page: number) => {
    const params = new URLSearchParams();
    params.set("attemptsPage", String(key === "attemptsPage" ? page : data.attemptsPagination.page));
    params.set("eventsPage", String(key === "eventsPage" ? page : data.unmatchedEventsPagination.page));
    params.set("itemsPage", String(key === "itemsPage" ? page : data.unpacketItemsPagination.page));
    params.set("heldPage", String(key === "heldPage" ? page : data.heldPacketsPagination.page));
    return `/staff/fulfillment/packets/reconciliation?${params.toString()}`;
  };
  const pagination = (label: string, key: QueueKey, page: number, totalPages: number, total: number, itemName: string) => <nav className={styles.pagination} aria-label={label}>
    {page > 1 && <Link className={styles.link} href={queueHref(key, page - 1)}>Previous page</Link>}
    <span>Page {page} of {totalPages} · {total} {itemName}{total === 1 ? "" : "s"}</span>
    {page < totalPages && <Link className={styles.link} href={queueHref(key, page + 1)}>Next page</Link>}
  </nav>;
  return <main className={styles.page}>
    <header className={styles.head}>
      <div>
        <h1>Packet reconciliation</h1>
        <p className={styles.muted}>Follow up on unclear sends, delivery issues, packet holds, unmatched provider events, and placements ready for a packet. This page hides article text and recipient addresses.</p>
      </div>
      <Link className={`${styles.link} ${styles.reconciliationBack}`} href="/staff/fulfillment">Back to fulfillment</Link>
    </header>
    <p className={styles.warning} role="note">If Resend is Accepted, Delayed, or still unclear, open the packet and use the audited manual handoff if the supplier needs it now. Resend may still deliver a separate copy; GPHKM records both attempts. Provider delivery or a recorded actual manual send moves eligible placements to Publication in Progress; supplier receipt is tracked separately. If delivery is still unconfirmed after 72 hours, it appears under Needs review. This is an internal follow-up target, not a supplier deadline.</p>

    <section className={styles.panel}>
      <h2>Needs review</h2>
      {pagination("Needs review pages", "attemptsPage", data.attemptsPagination.page, data.attemptsPagination.totalPages, data.attemptsPagination.total, "attempt")}
      {data.attempts.length ? <div className={styles.tableScroll} role="region" aria-label="Handoff attempts needing review" tabIndex={0}>
        <table className={`${styles.table} ${styles.reconciliationTable}`}><thead><tr>
          <th scope="col">Reason</th><th scope="col">Order</th><th scope="col">Packet</th><th scope="col">Email status</th><th scope="col">Provider email ID</th><th scope="col">Last update</th><th scope="col">Action</th>
        </tr></thead><tbody>{data.attempts.map((row) => <tr key={row.attemptId}>
          <td data-label="Reason">{reasonLabels[row.reason] ?? "Packet status changed — open it to review"}</td>
          <td data-label="Order">{row.orderReference}</td>
          <td data-label="Packet">{row.packetId}</td>
          <td data-label="Email status">{attemptStateLabels[row.state] ?? "Status unavailable"}</td>
          <td data-label="Provider email ID">{row.providerReference ?? "—"}</td>
          <td data-label="Last update">{(row.deliveredAt ?? row.acceptedAt ?? row.createdAt).toLocaleString()}</td>
          <td data-label="Action"><Link className={styles.link} href={`/staff/fulfillment/packets/${encodeURIComponent(row.packetId)}`}>Open packet</Link></td>
        </tr>)}</tbody></table>
      </div> : <p className={styles.empty}>No send attempts need follow-up right now.</p>}
    </section>

    <section className={styles.panel}>
      <h2>Packets held for staff review</h2>
      {pagination("Held packet pages", "heldPage", data.heldPacketsPagination.page, data.heldPacketsPagination.totalPages, data.heldPacketsPagination.total, "packet")}
      {data.heldPackets.length ? <div className={styles.tableScroll} role="region" aria-label="Packets held for staff review" tabIndex={0}>
        <table className={`${styles.table} ${styles.reconciliationTable}`}><thead><tr>
          <th scope="col">Order</th><th scope="col">Packet</th><th scope="col">Hold reason</th><th scope="col">Updated</th><th scope="col">Action</th>
        </tr></thead><tbody>{data.heldPackets.map((row) => <tr key={row.packetId}>
          <td data-label="Order">{row.orderReference}</td><td data-label="Packet">{row.packetId}</td>
          <td data-label="Hold reason">{row.holdReason}</td><td data-label="Updated">{row.updatedAt?.toLocaleString() ?? "Not recorded"}</td>
          <td data-label="Action"><Link className={styles.link} href={`/staff/fulfillment/packets/${encodeURIComponent(row.packetId)}`}>Open packet</Link></td>
        </tr>)}</tbody></table>
      </div> : <p className={styles.empty}>No packets are held for staff review.</p>}
    </section>

    <section className={styles.panel}>
      <h2>Ready placements without a packet</h2>
      {pagination("Placements without a packet pages", "itemsPage", data.unpacketItemsPagination.page, data.unpacketItemsPagination.totalPages, data.unpacketItemsPagination.total, "placement")}
      {data.unpacketItems.length ? <div className={styles.tableScroll} role="region" aria-label="Ready placements without a packet" tabIndex={0}>
        <table className={`${styles.table} ${styles.reconciliationTable}`}><thead><tr>
          <th scope="col">Order</th><th scope="col">Order item</th><th scope="col">Updated</th><th scope="col">Action</th>
        </tr></thead><tbody>{data.unpacketItems.map((row) => <tr key={row.itemId}>
          <td data-label="Order">{row.orderReference}</td><td data-label="Order item">{row.itemId}</td>
          <td data-label="Updated">{row.updatedAt.toLocaleString()}</td>
          <td data-label="Action"><Link className={styles.link} href={`/staff/fulfillment/${encodeURIComponent(row.itemId)}`}>Open placement</Link></td>
        </tr>)}</tbody></table>
      </div> : <p className={styles.empty}>No ready placements are missing a packet.</p>}
    </section>

    <section className={styles.panel}>
      <h2>Provider events waiting to be matched</h2>
      {pagination("Provider event pages", "eventsPage", data.unmatchedEventsPagination.page, data.unmatchedEventsPagination.totalPages, data.unmatchedEventsPagination.total, "event")}
      {data.unmatchedEvents.length ? <div className={styles.tableScroll} role="region" aria-label="Provider events waiting to be matched" tabIndex={0}>
        <table className={`${styles.table} ${styles.reconciliationTable}`}><thead><tr>
          <th scope="col">Event</th><th scope="col">Provider event ID</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Received</th><th scope="col">Packet</th>
        </tr></thead><tbody>{data.unmatchedEvents.map((row) => <tr key={row.eventId}>
          <td data-label="Event">{row.eventId}</td><td data-label="Provider event ID">{row.providerEventId}</td>
          <td data-label="Type">{row.eventType}</td><td data-label="Status">{row.state === "RECONCILIATION_REQUIRED" ? "Needs matching" : "Status unavailable"}</td>
          <td data-label="Received">{row.receivedAt.toLocaleString()}</td>
          <td data-label="Packet">{row.packetId ? <Link className={styles.link} href={`/staff/fulfillment/packets/${encodeURIComponent(row.packetId)}`}>Open packet</Link> : "No packet match — Super Admin review"}</td>
        </tr>)}</tbody></table>
      </div> : <p className={styles.empty}>No provider events are waiting to be matched.</p>}
    </section>
  </main>;
}
