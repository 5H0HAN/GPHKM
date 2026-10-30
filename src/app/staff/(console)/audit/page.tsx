import { headers } from "next/headers";
import Link from "next/link";
import { listStaffAuditEvents } from "@/server/audit/read";
import styles from "./audit.module.css";

export const dynamic = "force-dynamic";

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ before?: string | string[] }> }) {
  const query = await searchParams;
  const before = Array.isArray(query.before) ? query.before[0] : query.before;
  let events;
  try { events = await listStaffAuditEvents(await headers(), before); }
  catch { return <section className={styles.error}>Audit history is unavailable for this account.</section>; }

  return (
    <>
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>CONTROL PLANE</p><h1>Audit trail</h1>
          <p>Append-only actions available to your role, with safe correlation details.</p></div>
        <span className={styles.count}>{events.items.length} events on this page</span>
      </header>
      {!events.items.length ? <section className={styles.empty}>No audit events are available in this part of your scope.</section> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">Actor</th><th scope="col">Target</th><th scope="col">Result</th><th scope="col">Reference</th></tr></thead>
            <tbody>{events.items.map((event) => {
              const result = event.result ?? "—";
              return <tr key={event.id}>
                <td><time dateTime={event.createdAt.toISOString()}>{event.createdAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</time></td>
                <td><strong>{event.action.replaceAll("_", " ")}</strong>{event.reasonCode && <small>{event.reasonCode}</small>}</td>
                <td>{event.actorName ?? "System"}</td>
                <td><span>{event.targetType}</span><code>{event.targetId}</code></td>
                <td>{result}</td>
                <td>{event.correlationId ?? "—"}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}
      {events.nextCursor && <nav aria-label="Audit event pages" className={styles.pagination}><Link href={`/staff/audit?before=${encodeURIComponent(events.nextCursor)}`}>Older events</Link></nav>}
    </>
  );
}
