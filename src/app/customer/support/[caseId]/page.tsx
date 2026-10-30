import Link from "next/link";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { getCustomerSupportCase } from "@/server/support/cases";
import { loadCustomerWorkspace, selectedOrganizationId } from "../../workspace";
import { replySupportAction } from "../actions";
import styles from "@/components/support.module.css";
import { firstQueryValue } from "@/modules/query-params";

export const dynamic = "force-dynamic";
export default async function CustomerSupportDetail({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Promise<{ organizationId?: string | string[]; error?: string | string[]; before?: string | string[] }> }) {
  const workspace = await loadCustomerWorkspace();
  if (!workspace.authenticated) return null;
  const query = await searchParams;
  const before = firstQueryValue(query.before);
  const organizationId = selectedOrganizationId(workspace.organizations, firstQueryValue(query.organizationId));
  if (!organizationId) return <p>An organization is required.</p>;
  const { caseId } = await params;
  let item;
  try { item = await getCustomerSupportCase(await headers(), organizationId, caseId, before); }
  catch { return <p className={styles.notice}>This request is unavailable. <Link href={`/customer/support?organizationId=${encodeURIComponent(organizationId)}`}>Return to Support</Link></p>; }
  return <>
    <header className={styles.header}><div><h1>Support request</h1><p>{item.status} · Order {item.orderId.slice(0, 8)} · Updated {new Date(item.updatedAt).toLocaleDateString()}</p></div><Link className={styles.link} href={`/customer/support?organizationId=${encodeURIComponent(organizationId)}`}>All requests</Link></header>
    {query.error && <p className={styles.notice} role="alert">Your reply could not be saved. Check its length and try again.</p>}
    <section className={styles.panel}><h2>Your request</h2><p className={styles.body}>{item.summary}</p>{item.messages.map((message) => <article className={styles.message} key={message.id}><header><strong>{message.from}</strong><time dateTime={message.at}>{new Date(message.at).toLocaleString()}</time></header><p className={styles.body}>{message.body}</p></article>)}
      {item.olderCursor && <nav className={styles.pagination} aria-label="Customer Support message history"><span /> <Link href={`/customer/support/${item.id}?organizationId=${encodeURIComponent(organizationId)}&before=${encodeURIComponent(item.olderCursor)}`}>Earlier messages</Link></nav>}
    </section>
    {item.canReply ? <section className={styles.panel}><h2>Reply</h2><form action={replySupportAction} className={styles.form}>
      <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="caseId" value={item.id} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
      <label>Message<textarea name="body" maxLength={4000} rows={5} required /></label><button type="submit">Send reply</button>
    </form></section> : <p className={styles.notice}>This request is closed. You can open another request if you need help with this placement.</p>}
  </>;
}
