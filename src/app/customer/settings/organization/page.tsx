import Link from "next/link";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { getOrganizationSettings } from "@/server/identity/organization-lifecycle";
import { listOrganizationClosureRequests } from "@/server/identity/organization-closure";
import { loadCustomerWorkspace, selectedOrganizationId } from "../../workspace";
import { inviteMemberAction, promoteMemberAction, removeMemberAction, renameOrganizationAction, updateBillingProfileAction, replyOrganizationClosureAction, requestOrganizationClosureAction, revokeInvitationAction } from "./actions";
import styles from "../../customer.module.css";
import settings from "../settings.module.css";
import { firstQueryValue } from "@/modules/query-params";

export const dynamic = "force-dynamic";
export default async function OrganizationSettingsPage({ searchParams }: { searchParams: Promise<{ organizationId?: string | string[]; updated?: string | string[]; error?: string | string[] }> }) {
  const workspace = await loadCustomerWorkspace();
  if (!workspace.authenticated) return null;
  const query = await searchParams;
  const organizationId = selectedOrganizationId(workspace.organizations, firstQueryValue(query.organizationId));
  if (!organizationId) return <p className={styles.error}>An active organization is required.</p>;
  let data;
  try { data = await getOrganizationSettings(await headers(), organizationId); }
  catch { return <p className={styles.error}>Organization settings are unavailable. Refresh and check your membership.</p>; }
  const ownerCount = data.members.filter((member) => member.role === "OWNER").length;
  const closureRequests = data.role === "OWNER" ? await listOrganizationClosureRequests(await headers(), organizationId).catch(() => []) : [];
  return <>
    <div className={styles.headingRow}><div><h1 className={styles.title}>Organization settings</h1><p className={styles.subtitle}>{data.organization.name} · Your role: {data.role === "OWNER" ? "Owner" : "Member"}</p></div><Link className={styles.panelAction} href={`/customer/settings?organizationId=${encodeURIComponent(organizationId)}`}>Personal settings</Link></div>
    {query.updated && <p role="status" className={settings.notice}>Organization settings were updated.</p>}
    {query.error && <p role="alert" className={settings.notice}>{query.error === "invite-unavailable" ? data.delivery.message : query.error === "name" ? "The name could not be saved. Refresh to review the latest name and try again." : query.error === "billing" ? "The billing profile could not be saved. Check the legal name, email, and address, then try again." : query.error === "closure" ? "The closure request could not be opened. Check whether an active request already exists." : "The change could not be made. Check your current role and remember that the last Owner cannot leave or be removed."}</p>}
    {data.role !== "OWNER" ? <article className={styles.panel}><h2 className={styles.panelTitle}>Managed by your organization Owner</h2><p className={styles.panelText}>Owners manage the organization name, membership, and funding. Your personal profile and security settings remain yours.</p></article> : <>
      <article className={styles.panel}><h2 className={styles.panelTitle}>Organization name</h2><form action={renameOrganizationAction} className={settings.form}>
        <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="expectedName" value={data.organization.name} />
        <label>Name<input name="name" defaultValue={data.organization.name} minLength={2} maxLength={120} autoComplete="organization" required /></label><button type="submit">Save organization name</button>
      </form></article>
      <article className={styles.panel}><h2 className={styles.panelTitle}>Billing profile</h2>
        <p className={styles.panelText}>Optional details for future organization billing. This profile is visible only to Owners and is never included in supplier instructions.</p>
        <form action={updateBillingProfileAction} className={settings.form}>
          <input type="hidden" name="organizationId" value={organizationId} />
          <label>Legal name<input name="legalName" defaultValue={data.billingProfile?.legalName ?? ""} maxLength={160} autoComplete="organization" /></label>
          <label>Billing email<input name="billingEmail" type="email" defaultValue={data.billingProfile?.billingEmail ?? ""} maxLength={254} autoComplete="billing email" /></label>
          <label>Billing address<textarea name="billingAddress" defaultValue={data.billingProfile?.billingAddress ?? ""} maxLength={1000} autoComplete="billing street-address" /></label>
          <button type="submit">Save billing profile</button>
        </form>
      </article>
      <article className={styles.panel}><h2 className={styles.panelTitle}>Members</h2><p className={styles.panelText}>Owners can manage funds, membership, and settings. Members can place orders and see their own orders. Promote another Member to Owner before the last Owner leaves.</p>
        <ul className={settings.members}>{data.members.map((member) => {
          const self = member.userId === workspace.customer.userId;
          const lastOwner = member.role === "OWNER" && ownerCount === 1;
          return <li className={settings.member} key={member.userId}><div><strong>{member.name}{self ? " (you)" : ""}</strong><p>{member.email}</p><p>{member.role === "OWNER" ? "Owner" : "Member"}</p></div><div>
            {member.role === "MEMBER" && <form action={promoteMemberAction}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="userId" value={member.userId} /><label className={settings.confirmation}><input name="confirmed" type="checkbox" required />Grant shared Owner control of funds, members, and settings.</label><button type="submit">Make co-Owner</button></form>}
            <form action={removeMemberAction}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="userId" value={member.userId} />{!lastOwner && <label className={settings.confirmation}><input type="checkbox" name="confirmed" required />{self ? "I want to leave this organization." : "Remove this person’s organization access."}</label>}<button type="submit" disabled={lastOwner}>{self ? "Leave organization" : "Remove access"}</button>{lastOwner && <p>Another Owner is required before this account can leave.</p>}</form>
          </div></li>;
        })}</ul>
      </article>
      <article className={styles.panel}><h2 className={styles.panelTitle}>Invite a Member</h2><p className={settings.notice}>{data.delivery.message}</p><form action={inviteMemberAction} className={settings.form}>
        <input type="hidden" name="organizationId" value={organizationId} /><label>Verified email<input name="email" type="email" maxLength={254} autoComplete="off" required disabled={!data.delivery.available} /></label><button type="submit" disabled={!data.delivery.available}>Send Member invitation</button>
      </form><p className={styles.panelText}>Invitations grant Member access, are bound to the recipient’s verified email, and expire after seven days. Invite secrets are not displayed here.</p></article>
      <article className={styles.panel}><h2 className={styles.panelTitle}>Invitation history</h2>{!data.invitations.length ? <p className={styles.panelText}>No invitations have been created for this organization.</p> : <ul className={settings.members}>{data.invitations.map((invite) => <li className={settings.member} key={invite.id}><div><strong>{invite.email}</strong><p>{invite.displayStatus.toLowerCase()} · Member · Email: {invite.deliveryStatus === "SENT" ? "accepted by provider" : invite.deliveryStatus?.toLowerCase() ?? "not queued"}</p><time dateTime={invite.expiresAt.toISOString()}>Expires {invite.expiresAt.toLocaleString()}</time></div>{invite.canRevoke && <form action={revokeInvitationAction}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="invitationId" value={invite.id} /><label className={settings.confirmation}><input type="checkbox" name="confirmed" required />Invalidate this invitation.</label><button type="submit">Revoke invitation</button></form>}</li>)}</ul>}</article>
      <article className={styles.panel}><h2 className={styles.panelTitle}>Organization closure</h2><p className={styles.panelText}>Request closure through Support. Staff can complete it only after the wallet balance is zero and active orders, payment disputes, and support cases are resolved. Closure disables organization access; financial and audit records remain retained under policy.</p>
        {closureRequests.map((request) => <div className={settings.member} key={request.id}><div><strong>Request {request.id.slice(0, 8)} · {request.state.toLowerCase().replaceAll("_", " ")}</strong><p>Updated {request.updatedAt.toLocaleString()}</p>
          {request.history.map((event) => <p className={styles.panelText} key={event.id}>{event.actorKind === "CUSTOMER" ? "You" : "GPHKM Support"} · {event.body}</p>)}
          {request.canReply && <form action={replyOrganizationClosureAction} className={settings.form}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="requestId" value={request.id} /><input type="hidden" name="idempotencyKey" value={randomUUID()} /><label>Reply to Support<textarea name="body" maxLength={2000} rows={3} required /></label><button type="submit">Send reply</button></form>}
        </div></div>)}
        {!closureRequests.some((request) => request.state !== "CLOSED") && <form action={requestOrganizationClosureAction} className={settings.form}>
          <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label>Why are you requesting organization closure?<textarea name="summary" minLength={5} maxLength={2000} rows={4} required /></label>
          <label className={settings.confirmation}><input type="checkbox" name="confirmed" required />I understand active orders and a nonzero wallet balance must be resolved before closure.</label>
          <button type="submit">Send closure request</button>
        </form>}
      </article>
    </>}
  </>;
}
