import Link from "next/link";
import { headers } from "next/headers";
import { listApprovedAfterDispatchNoticeReconciliation } from "@/server/fulfillment/supplier-notices";
import styles from "@/components/support.module.css";

export const dynamic = "force-dynamic";
export default async function SupplierNoticeReconciliationPage() {
  const rows = await listApprovedAfterDispatchNoticeReconciliation(await headers());
  return <>
    <header className={styles.header}><div><h1>Supplier notice reconciliation</h1><p>Post-handoff refunds were approved after supplier dispatch. Confirm the supplier outcome in the linked Support case; provider acceptance does not mean work stopped.</p></div><Link href="/staff/support">Back to Support</Link></header>
    <section className={styles.panel}><h2>{rows.length} unresolved notices</h2>{rows.length ? rows.map(({ notice, attempt, refund }) => <Link className={styles.row} href={`/staff/support/${notice.caseId}`} key={`${notice.id}:${attempt.id}`}>
      <strong>{notice.noticeType.toLowerCase()} · item {notice.orderItemId.slice(0, 8)}</strong>
      <span>Notice {attempt.state.toLowerCase().replaceAll("_", " ")} · approved {refund.decidedAt?.toLocaleString() ?? "unknown date"} · {notice.recipient}</span>
    </Link>) : <p>No unresolved approved-after-dispatch notices.</p>}</section>
  </>;
}
