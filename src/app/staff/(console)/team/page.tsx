import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { listStaffAccounts, listStaffInvitations } from "@/server/identity/staff-lifecycle";
import { activateStaffAction, changeStaffRoleAction, deactivateStaffAction, inviteStaffAction, revokeStaffInvitationAction } from "./actions";
import { organizationInvitationDeliveryStatus } from "@/modules/identity/organizations";
import styles from "./team.module.css";
import { localStaffMfaDisabled } from "@/server/auth/policy";

export const dynamic = "force-dynamic";

const outcomes: Record<string, string> = {
  activated: "Staff access activated. Existing sessions were revoked.",
  role: "Staff role updated. Existing sessions were revoked.",
  deactivated: "Staff access deactivated and sessions revoked.",
  unchanged: "The selected role is already assigned. No session or access change was made.",
  invitation: "Invitation status was updated.",
};

export default async function StaffTeamPage({ searchParams }: { searchParams: Promise<{ updated?: string; error?: string }> }) {
  const query = await searchParams;
  let staff;
  let invitations;
  try {
    const requestHeaders = await headers();
    [staff, invitations] = await Promise.all([listStaffAccounts(requestHeaders), listStaffInvitations(requestHeaders)]);
  }
  catch { redirect("/staff"); }
  const current = staff.find((member) => member.isCurrentUser);
  const canInvite = current?.role === "SUPER_ADMIN";
  const delivery = organizationInvitationDeliveryStatus();
  const localMfaBypass = localStaffMfaDisabled(process.env);

  return <>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>ACCESS CONTROL</p><h1>Staff access</h1><p className={styles.lede}>Manage staff roles, invitations, MFA activation, and session revocation.</p></div>
      <span className={styles.count}>{staff.filter((member) => member.active).length} active · {staff.length} accounts</span>
    </header>
    {query.updated && outcomes[query.updated] && <p role="status" className={styles.notice}>{outcomes[query.updated]}</p>}
    {query.error && <p role="alert" className={styles.error}>The change could not be applied. Check the staff account, MFA status, and last Super Admin protection.</p>}
    {canInvite && <section className={styles.empty}>
      <h2>Invite staff</h2>
      <p>Invitations are email-bound, expire after seven days, and can grant Admin or Finance only. Staff access remains inactive until MFA is verified and a Super Admin activates it.</p>
      {!delivery.available && <p role="status">{delivery.message}</p>}
      <form action={inviteStaffAction} className={styles.inviteForm}>
        <label>Email<input name="email" type="email" maxLength={254} autoComplete="off" required disabled={!delivery.available} /></label>
        <label>Role<select name="role" defaultValue="ADMIN" disabled={!delivery.available}><option value="ADMIN">Admin</option><option value="FINANCE">Finance</option></select></label>
        <label><input type="checkbox" name="confirmed" required disabled={!delivery.available} />Send an invitation to this address.</label>
        <button type="submit" disabled={!delivery.available}>Send staff invitation</button>
      </form>
      {invitations.length > 0 && <div className={styles.tableWrap}><table><thead><tr><th>Invitee</th><th>Role</th><th>Status</th><th>Email</th><th>Expires</th><th>Action</th></tr></thead><tbody>
        {invitations.map((invite) => <tr key={invite.id}><td>{invite.email}</td><td>{invite.role}</td><td>{invite.displayStatus}</td>
          <td>{invite.deliveryStatus === "SENT" ? "Accepted by provider" : invite.deliveryStatus ?? "Not queued"}</td>
          <td>{invite.expiresAt.toLocaleString()}</td><td>{invite.canRevoke && <form action={revokeStaffInvitationAction}>
            <input type="hidden" name="invitationId" value={invite.id} />
            <label><input type="checkbox" name="confirmed" required />Invalidate invitation</label>
            <button className={styles.danger} type="submit">Revoke</button>
          </form>}</td></tr>)}
      </tbody></table></div>}
    </section>}
    <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Staff accounts, scroll horizontally when needed">
      <table><thead><tr><th>Staff member</th><th>Role</th><th>Access</th><th>MFA</th><th>Actions</th></tr></thead>
        <tbody>{staff.map((member) => {
          return <tr key={member.userId}>
            <td><strong>{member.name}</strong><small>{member.email}</small></td>
            <td><span className={styles.role}>{member.role.replaceAll("_", " ")}</span></td>
            <td><span className={member.active ? styles.active : styles.inactive}>{member.active ? "Active" : "Inactive"}</span></td>
            <td>{member.twoFactorEnabled && member.verifiedTotp ? "TOTP verified" : localMfaBypass ? "Not verified · local bypass" : "Not verified"}</td>
            <td className={styles.actions}>
              {!member.isCurrentUser && !member.active && <form action={activateStaffAction}>
                <input type="hidden" name="userId" value={member.userId} />
                <label><input type="checkbox" name="confirmed" required disabled={!(member.twoFactorEnabled && member.verifiedTotp)} />Confirm activation</label>
                <button type="submit" disabled={!(member.twoFactorEnabled && member.verifiedTotp)}>Activate</button>
                {!(member.twoFactorEnabled && member.verifiedTotp) && <small>Verified TOTP is required before activation.</small>}
              </form>}
              {member.role !== "SUPER_ADMIN" && member.active && !member.isCurrentUser && <form action={changeStaffRoleAction}>
                  <input type="hidden" name="userId" value={member.userId} />
                  <label>Change role<select name="role" defaultValue={member.role}><option value="ADMIN">Admin</option><option value="FINANCE">Finance</option></select></label>
                  <label><input type="checkbox" name="confirmed" required />Confirm role change and revoke sessions</label>
                  <button type="submit">Save role</button>
                </form>}
              {member.active && !member.isCurrentUser && <>
                <form action={deactivateStaffAction}>
                  <input type="hidden" name="userId" value={member.userId} />
                  <label>Reason<select name="reasonCode" required defaultValue=""><option value="" disabled>Select a reason</option><option value="STAFF_DEPARTED">Staff departed</option><option value="SECURITY_REVIEW">Security review</option><option value="ACCESS_CHANGE">Access change</option></select></label>
                  <label><input type="checkbox" name="confirmed" required />End access and revoke sessions</label>
                  <button className={styles.danger} type="submit">Deactivate</button>
                </form>
              </>}
              {member.role === "SUPER_ADMIN" && <small>{member.isCurrentUser ? "Your own access cannot be changed here." : "Super Admin role is controlled by bootstrap; deactivation remains protected by the last-owner rule."}</small>}
            </td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {staff.length === 0 && <section className={styles.empty}><strong>No staff accounts</strong><p>Staff accounts are provisioned through controlled bootstrap or invitation.</p></section>}
    <p className={styles.footerNote}>{localMfaBypass ? "Local testing bypasses staff MFA only in this development environment. Production requires verified MFA. Role checks, database controls, and audit rules remain active." : "Every role or access change is audited. Super Admin access cannot bypass MFA, database controls, or the audit trail."}</p>
  </>;
}
