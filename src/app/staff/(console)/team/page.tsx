import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireStaffAccess } from "@/server/auth/staff";
import { listStaffAccounts, listStaffInvitations } from "@/server/identity/staff-lifecycle";
import { activateStaffAction, changeStaffRoleAction, deactivateStaffAction, inviteStaffAction, promoteSuperAdminAction, resetStaffTotpAction, revokeStaffInvitationAction } from "./actions";
import { organizationInvitationDeliveryStatus } from "@/modules/identity/organizations";
import styles from "./team.module.css";

export const dynamic = "force-dynamic";

const outcomes: Record<string, string> = {
  activated: "Staff access activated or reactivated. Existing sessions were revoked.",
  role: "Staff role updated. Existing sessions were revoked.",
  deactivated: "Staff access deactivated and sessions revoked.",
  unchanged: "The selected role is already assigned. No session or access change was made.",
  invitation: "Invitation status was updated.",
  promoted: "Admin promoted to Super Admin. Existing sessions were revoked.",
  totpReset: "The authenticator was reset and the staff member’s sessions were revoked.",
};

export default async function StaffTeamPage({ searchParams }: { searchParams: Promise<{ updated?: string; error?: string }> }) {
  const query = await searchParams;
  let staff;
  let invitations;
  let actor: Awaited<ReturnType<typeof requireStaffAccess>>;
  try {
    const requestHeaders = await headers();
    actor = await requireStaffAccess(requestHeaders, "staff.manage");
    [staff, invitations] = await Promise.all([listStaffAccounts(requestHeaders), listStaffInvitations(requestHeaders)]);
  }
  catch { redirect("/staff"); }
  const actorUserId = actor.userId;
  const canInvite = actor.role === "SUPER_ADMIN";
  const delivery = organizationInvitationDeliveryStatus();

  return <>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>ACCESS CONTROL</p><h1>Staff access</h1><p className={styles.lede}>Manage staff roles, invitations, activation, and session revocation.</p></div>
      <span className={styles.count}>{staff.filter((member) => member.active).length} active · {staff.length} accounts</span>
    </header>
    {query.updated && outcomes[query.updated] && <p role="status" className={styles.notice}>{outcomes[query.updated]}</p>}
    {query.error && <p role="alert" className={styles.error}>The change could not be applied. Check the account status and try again.</p>}
    {canInvite && <section className={styles.empty}>
      <h2>Invite staff</h2>
      <p>Invitations are email-bound, expire after seven days, and can grant Admin or Finance only. A Super Admin activates access after the invitee verifies the invitation email.</p>
      {!delivery.available && <p role="status">{delivery.message}</p>}
      <form action={inviteStaffAction} className={styles.inviteForm}>
        <label>Email<input name="email" type="email" maxLength={254} autoComplete="off" required disabled={!delivery.available} /></label>
        <label>Role<select name="role" defaultValue="ADMIN" disabled={!delivery.available}><option value="ADMIN">Admin</option><option value="FINANCE">Finance</option></select></label>
        <label><input type="checkbox" name="confirmed" required disabled={!delivery.available} />Send an invitation to this address.</label>
        <button type="submit" disabled={!delivery.available}>Send staff invitation</button>
      </form>
      {invitations.length > 0 && <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Staff invitations, scroll horizontally when needed"><table><thead><tr><th>Invitee</th><th>Role</th><th>Status</th><th>Email</th><th>Expires</th><th>Action</th></tr></thead><tbody>
        {invitations.map((invite) => <tr key={invite.id}><th scope="row">{invite.email}</th><td>{invite.role}</td><td>{invite.displayStatus}</td>
          <td>{invite.deliveryStatus === "SENT" ? "Accepted by provider" : invite.deliveryStatus ?? "Not queued"}</td>
          <td>{invite.expiresAt.toLocaleString()}</td><td>{invite.canRevoke && <form action={revokeStaffInvitationAction}>
            <input type="hidden" name="invitationId" value={invite.id} />
            <label><input type="checkbox" name="confirmed" required />Invalidate invitation</label>
            <button className={styles.danger} type="submit" aria-label={`Revoke invitation for ${invite.email}`}>Revoke</button>
          </form>}</td></tr>)}
      </tbody></table></div>}
    </section>}
    <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Staff accounts, scroll horizontally when needed">
      <table><thead><tr><th>Staff member</th><th>Role</th><th>Access</th><th>Sign-in checks</th><th>Actions</th></tr></thead>
        <tbody>{staff.map((member) => {
          const isCurrentUser = member.userId === actorUserId;
          const ready = member.emailVerified && member.totpReady;
          const identity = `${member.name} (${member.email})`;
          const memberHeading = `staff-member-${member.userId}`;
          return <tr key={member.userId}>
            <th scope="row" id={memberHeading}><strong>{member.name}</strong><small>{member.email}</small></th>
            <td><span className={styles.role}>{member.role.replaceAll("_", " ")}</span></td>
            <td><span className={member.active ? styles.active : styles.inactive}>{member.active ? "Active" : "Inactive"}</span></td>
            <td>
              <span>{member.emailVerified ? "Email verified" : "Email unverified"}</span>
              <span>{member.totpReady ? "TOTP verified" : "TOTP not verified"}</span>
            </td>
            <td className={styles.actions}>
              {!isCurrentUser && !member.active && <form action={activateStaffAction}>
                <input type="hidden" name="userId" value={member.userId} />
                <label><input type="checkbox" name="confirmed" aria-describedby={memberHeading} required disabled={!ready} />Confirm activation</label>
                <button type="submit" disabled={!ready} aria-label={`${member.role === "SUPER_ADMIN" ? "Reactivate" : "Activate"} ${identity}`}>
                  {member.role === "SUPER_ADMIN" ? "Reactivate" : "Activate"}
                </button>
                {!ready && <small>A verified email and authenticator are required.</small>}
              </form>}
              {member.role !== "SUPER_ADMIN" && member.active && !isCurrentUser && <form action={changeStaffRoleAction}>
                  <input type="hidden" name="userId" value={member.userId} />
                  <label>Change role<select name="role" aria-describedby={memberHeading} defaultValue={member.role}><option value="ADMIN">Admin</option><option value="FINANCE">Finance</option></select></label>
                  <label><input type="checkbox" name="confirmed" aria-describedby={memberHeading} required />Confirm role change and revoke sessions</label>
                  <button type="submit" aria-label={`Save role for ${identity}`}>Save role</button>
                </form>}
              {!isCurrentUser && <form action={resetStaffTotpAction}>
                <input type="hidden" name="userId" value={member.userId} />
                <label><input type="checkbox" name="confirmed" aria-describedby={memberHeading} required />Reset authenticator and revoke sessions</label>
                <button className={styles.danger} type="submit" aria-label={`Reset authenticator for ${identity}`}>Reset authenticator</button>
              </form>}
              {member.active && !isCurrentUser && <>
                <form action={deactivateStaffAction}>
                  <input type="hidden" name="userId" value={member.userId} />
                  <label>Reason<select name="reasonCode" aria-describedby={memberHeading} required defaultValue=""><option value="" disabled>Select a reason</option><option value="STAFF_DEPARTED">Staff departed</option><option value="SECURITY_REVIEW">Security review</option><option value="ACCESS_CHANGE">Access change</option></select></label>
                  <label><input type="checkbox" name="confirmed" aria-describedby={memberHeading} required />End access and revoke sessions</label>
                  <button className={styles.danger} type="submit" aria-label={`Deactivate ${identity}`}>Deactivate</button>
                </form>
              </>}
              {!isCurrentUser && member.role === "ADMIN" && member.active && ready && <form action={promoteSuperAdminAction}>
                <input type="hidden" name="userId" value={member.userId} />
                <label><input type="checkbox" name="confirmed" aria-describedby={memberHeading} required />Grant Super Admin access and revoke sessions</label>
                <button type="submit" aria-label={`Promote to Super Admin: ${identity}`}>Promote to Super Admin</button>
              </form>}
              {isCurrentUser && <small>Your own access cannot be changed here.</small>}
            </td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {staff.length === 0 && <section className={styles.empty}><strong>No staff accounts</strong><p>Staff accounts are provisioned through controlled bootstrap or invitation.</p></section>}
    <p className={styles.footerNote}>Every role or access change is audited. Active status, server-side permissions, database controls, and the audit trail protect staff access.</p>
  </>;
}
