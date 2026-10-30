import Link from "next/link";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { getCustomerSupportCase } from "@/server/support/cases";
import { loadCustomerWorkspace, selectedOrganizationId } from "../../workspace";
import { replySupportAction } from "../actions";
import styles from "../customer-support.module.css";
import { firstQueryValue } from "@/modules/query-params";

export const dynamic = "force-dynamic";

function customerStatus(status: string) {
  const normalized = status.toLowerCase();
  if (normalized.includes("waiting")) return "Waiting on you";
  if (normalized.includes("review")) return "In review";
  if (normalized.includes("resolved")) return "Resolved";
  return "Received";
}

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
  return <div className={styles.supportDetail}>
    <header className={styles.detailHeading}>
      <div>
        <p className={styles.detailOverline}>Support conversation</p>
        <h1>Support request</h1>
        <div className={styles.detailMeta}>
          <span className={`${styles.statusBadge} ${customerStatus(item.status) === "Resolved" ? styles.statusResolved : customerStatus(item.status) === "Waiting on you" ? styles.statusWaiting : ""}`}>{customerStatus(item.status)}</span>
          <span>Order #{item.orderId.slice(0, 8).toUpperCase()}</span>
          <span>Updated {new Date(item.updatedAt).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}</span>
        </div>
      </div>
      <Link className={styles.allRequests} href={`/customer/support?organizationId=${encodeURIComponent(organizationId)}`}>← All requests</Link>
    </header>
    {query.error && <p className={styles.supportError} role="alert">Your reply couldn’t be sent. Check that it is no longer than 4,000 characters, then try again.</p>}
    <section className={styles.conversationPanel} aria-labelledby="conversation-title">
      <header className={styles.conversationTitle}><h2 id="conversation-title">Conversation</h2><span>Updates and replies for this request</span></header>
      <div className={styles.originalRequest}><span>Your original message</span><p>{item.summary}</p></div>
      {item.messages.length > 0 && <div className={styles.messageList}>
        {item.messages.map((message) => <article className={`${styles.message} ${message.from === "Customer" ? styles.messageFromCustomer : styles.messageFromStaff}`} key={message.id}>
          <header><strong>{message.from === "Customer" ? "You" : "GPHKM Support"}</strong><time dateTime={message.at}>{new Date(message.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</time></header>
          <p>{message.body}</p>
        </article>)}
      </div>}
      {item.messages.length === 0 && <p className={styles.waitingMessage}>Your request has been received. We’ll post any customer-visible update here.</p>}
      {item.olderCursor && <nav className={styles.olderMessages} aria-label="Customer Support message history"><Link href={`/customer/support/${item.id}?organizationId=${encodeURIComponent(organizationId)}&before=${encodeURIComponent(item.olderCursor)}`}>Load earlier replies</Link></nav>}
    </section>
    {item.canReply ? <section className={styles.replyPanel} aria-labelledby="reply-title">
      <h2 id="reply-title">Add a reply</h2><p>Keep your message focused on this order. Don’t include payment details or passwords.</p>
      <form action={replySupportAction} className={styles.replyForm}>
        <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="caseId" value={item.id} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
        <label>Your message<textarea name="body" maxLength={4000} rows={5} required placeholder="Write a reply…" /></label><button type="submit">Send reply</button>
      </form>
    </section> : <div className={styles.closedNotice}>
      <p>This request is resolved and closed. If you still need help, open a new Support request for this placement.</p>
      <Link href={`/customer/support?organizationId=${encodeURIComponent(organizationId)}&itemId=${item.orderItemId}`}>Open a new request</Link>
    </div>}
  </div>;
}
