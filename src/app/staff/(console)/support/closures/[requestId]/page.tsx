import Link from "next/link";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { getStaffOrganizationClosure } from "@/server/identity/organization-closure";
import styles from "@/components/support.module.css";
import { closureMessageAction, closureUpdateAction } from "../actions";

export const dynamic = "force-dynamic";
const label = (value: string) => value.replaceAll("_", " ").toLowerCase();
const blockerLabels: Record<string, string> = {
  WALLET_BALANCE: "Wallet balance must be zero",
  ACTIVE_ORDERS: "Active or unpaid orders remain",
  OPEN_STRIPE_CASES: "Stripe reconciliation cases remain open",
  OPEN_SUPPORT_CASES: "Support cases remain unresolved",
  UNRESOLVED_PAYMENTS: "Payment attempts remain unresolved",
};

export default async function OrganizationClosurePage({ params, searchParams }: {
  params: Promise<{ requestId: string }>;
  searchParams: Promise<{ error?: string; updated?: string }>;
}) {
  const { requestId } = await params;
  const query = await searchParams;
  let data;
  try { data = await getStaffOrganizationClosure(await headers(), requestId); }
  catch { return <section className={styles.panel}><h1>Closure request unavailable</h1><Link href="/staff/support">Return to Support</Link></section>; }
  const { request, organizationName, blockers, history } = data;
  const open = request.state !== "CLOSED";
  return <>
    <header className={styles.header}><div><h1>Organization closure</h1><p>{organizationName} · {label(request.state)} · Opened {request.createdAt.toLocaleString()}</p></div><Link className={styles.link} href="/staff/support">All Support</Link></header>
    {query.error && <p role="alert" className={styles.notice}>The action could not be saved. Refresh the request and check its current state and closure blockers.</p>}
    {query.updated && <p role="status" className={styles.notice}>The closure request was updated and audited.</p>}
    <div className={styles.grid}>
      <section className={styles.panel}><h2>Request history</h2><p className={styles.body}>{request.summary}</p>{history.map((event) => <article className={`${styles.message} ${event.audience === "INTERNAL" ? styles.internal : ""}`} key={event.id}>
        <header><strong>{event.audience === "INTERNAL" ? "Internal note" : event.actorKind === "CUSTOMER" ? "Owner request" : "GPHKM reply"}</strong><time dateTime={event.createdAt.toISOString()}>{event.createdAt.toLocaleString()}</time></header>
        {event.fromState && <p className={styles.meta}>{label(event.fromState)} → {label(event.toState ?? "")}</p>}<p className={styles.body}>{event.body}</p>
      </article>)}</section>
      <div>
        <section className={styles.panel}><h2>Closure readiness</h2>{blockers.length ? <ul>{blockers.map((blocker) => <li key={blocker}>{blockerLabels[blocker] ?? "A closure requirement remains"}</li>)}</ul> : <p>No active wallet, order, payment, or support blockers were found.</p>}
          <p>Finalization rechecks all blockers in the database while locking the organization. Closure deactivates memberships and pending invitations; financial and audit records remain.</p>
        </section>
        {open && <section className={styles.panel}><h2>Update request</h2><form action={closureUpdateAction} className={styles.form}>
          <input type="hidden" name="requestId" value={request.id} /><input type="hidden" name="expectedState" value={request.state} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label>State<select name="to" defaultValue="INVESTIGATING"><option value="INVESTIGATING">Investigating</option><option value="WAITING_ON_CUSTOMER">Waiting on customer</option>{!blockers.length && <option value="CLOSED">Close organization</option>}</select></label>
          <label>Customer-visible update<textarea name="message" minLength={1} maxLength={2000} rows={4} required /></label>
          <label>Optional private staff note<textarea name="internalNote" maxLength={2000} rows={3} /></label>
          <button type="submit">Save update</button>
        </form></section>}
        {open && <section className={styles.panel}><h2>Message the Owner</h2><form action={closureMessageAction} className={styles.form}>
          <input type="hidden" name="requestId" value={request.id} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label>Message<textarea name="body" minLength={1} maxLength={2000} rows={4} required /></label>
          <label><input type="checkbox" name="internal" /> Record as private internal note</label>
          <button type="submit">Record message</button>
        </form></section>}
      </div>
    </div>
  </>;
}
