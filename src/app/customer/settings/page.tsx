import styles from "../customer.module.css";
import { loadCustomerWorkspace } from "../workspace";
import { ProfileNameForm } from "../profile-name-form";
import { ThemeToggle } from "@/components/theme-toggle";
import Link from "next/link";
import { selectedOrganizationId } from "../workspace";
import { currentLegalDocuments } from "@/modules/legal/policy";
import { headers } from "next/headers";
import { getCustomerNewsletterPreference, getCustomerNotificationEmailPreference } from "@/server/notifications/customer";
import { revokeOtherSessionsAction, revokeSessionAction, saveNewsletterPreference, saveNotificationPreference } from "./actions";
import { listCustomerSessions } from "@/server/identity/customer-sessions";
import settings from "./settings.module.css";
import { readAppearancePreference } from "@/server/identity/appearance";
import { listCustomerLegalAcceptanceHistory } from "@/server/legal/consent";
import { firstQueryValue } from "@/modules/query-params";
import { getAuthForSurface } from "@/server/auth";
import { PasswordChangeForm } from "./password-change-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ organizationId?: string | string[]; updated?: string | string[]; sessions?: string | string[]; sessionError?: string | string[]; notificationError?: string | string[]; newsletterError?: string | string[] }> }) {
  const workspace = await loadCustomerWorkspace();
  if (!workspace.authenticated) return null;
  const [appearance, requestHeaders] = await Promise.all([
    readAppearancePreference(workspace.customer.userId), headers(),
  ]);
  const [emailNotificationsEnabled, newsletterPreference, legalHistory] = await Promise.all([
    getCustomerNotificationEmailPreference(requestHeaders), getCustomerNewsletterPreference(requestHeaders),
    listCustomerLegalAcceptanceHistory(requestHeaders),
  ]);
  const authAccounts = await getAuthForSurface("customer").api.listUserAccounts({ headers: requestHeaders }).catch(() => []);
  const hasPasswordAccount = authAccounts.some((account) => account.providerId === "credential");
  const hasGoogleAccount = authAccounts.some((account) => account.providerId === "google");
  const signInMethods = [hasGoogleAccount ? "Google" : null, hasPasswordAccount ? "Email and password" : null].filter(Boolean).join(", ") || "Unavailable";
  let sessions: Awaited<ReturnType<typeof listCustomerSessions>> | null = null;
  try { sessions = await listCustomerSessions(await headers()); } catch { /* Require a fresh authenticated session to review device sessions. */ }
  const query = await searchParams;
  const organizationId = selectedOrganizationId(workspace.organizations, firstQueryValue(query.organizationId));
  const organization = workspace.organizations.find((item) => item.id === organizationId);
  const suffix = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";
  let documents;
  try { documents = currentLegalDocuments(process.env); } catch { documents = null; }

  return (
    <>
      <div className={styles.headingRow}>
        <div>
          <h1 className={styles.title}>Settings</h1>
          <p className={styles.subtitle}>Manage your personal sign-in and organization details.</p>
        </div>
      </div>
      {firstQueryValue(query.updated) === "left" && <p role="status" className={settings.notice}>You have left the organization. Your other memberships remain available.</p>}
      {firstQueryValue(query.updated) === "notifications" && <p role="status" className={settings.notice}>Email notification preference saved.</p>}
      {firstQueryValue(query.updated) === "newsletter" && <p role="status" className={settings.notice}>Newsletter preference saved.</p>}
      {firstQueryValue(query.notificationError) && <p role="alert" className={settings.notice}>Email notifications could not be saved. Refresh the page and try again.</p>}
      {firstQueryValue(query.newsletterError) && <p role="alert" className={settings.notice}>Newsletter preference could not be saved. Check that the consent notice is configured and try again.</p>}
      {firstQueryValue(query.sessions) === "updated" && <p role="status" className={settings.notice}>The session change was applied.</p>}
      {firstQueryValue(query.sessionError) && <p role="alert" className={settings.notice}>Sessions could not be changed. Refresh the page and try again after signing in recently.</p>}
      <section className={styles.grid}>
        <article id="security" className={`${styles.panel} ${styles.span7}`}>
          <h2 className={styles.panelTitle}>Profile</h2>
          <ul className={styles.list}>
            <li className={styles.listItem}><span>Verified email</span><span>{workspace.customer.email}</span></li>
            <li className={styles.listItem}><span>Sign-in method</span><span>{signInMethods}</span></li>
          </ul>
          <ProfileNameForm initialName={workspace.customer.name} />
          {hasPasswordAccount && <>
            <h3 className={styles.panelTitle}>Password</h3>
            <p className={styles.panelText}>Use your current password to choose a new one. Other active sessions will be signed out.</p>
            <PasswordChangeForm />
          </>}
          {hasGoogleAccount && <>
            <p className={styles.panelText}>Your Google password and account recovery are managed by Google.</p>
            <div className={settings.links}><a href="https://myaccount.google.com/" rel="noopener noreferrer">Manage Google Account</a><a href="https://accounts.google.com/signin/recovery" rel="noopener noreferrer">Google account recovery</a></div>
          </>}
          <div className={settings.links}><Link href={`/customer/settings${suffix}#security`}>Account security</Link><Link href={`/customer/support${suffix}`}>Support</Link></div>
        </article>
        <article className={`${styles.panel} ${styles.span5}`}>
          <h2 className={styles.panelTitle}>Organization</h2>
          <ul className={styles.list}>
            <li className={styles.listItem}><span>Name</span><span>{organization?.name ?? "Not set"}</span></li>
            <li className={styles.listItem}><span>Your role</span><span>{organization?.role ?? "Not set"}</span></li>
          </ul>
          <p className={styles.panelText}>{organization?.role === "OWNER" ? "Manage your organization name, members, co-Owners, and invitations." : "Your organization Owner manages membership, shared funding, and settings."}</p>
          {organization && <Link className={styles.panelAction} href={`/customer/settings/organization${suffix}`}>{organization.role === "OWNER" ? "Manage organization" : "View organization"}</Link>}
        </article>
        <article className={`${styles.panel} ${styles.span12}`}>
          <h2 className={styles.panelTitle}>Active sessions</h2>
          <p className={styles.panelText}>Review recent sign-ins for this verified account. Revoking a session signs that device out; the current session stays active.</p>
          {sessions === null ? <p className={settings.notice}>Sign in recently to review and revoke sessions.</p> : <>
            {!sessions.length ? <p className={styles.panelText}>No active sessions were returned.</p> : <ul className={settings.members}>{sessions.map((item) => <li className={settings.member} key={item.id}>
              <div><strong>{item.current ? "This session" : "Other session"}</strong><p>Started {item.createdAt.toLocaleString()}</p><p>Expires {item.expiresAt.toLocaleString()}</p></div>
              {!item.current && <form action={revokeSessionAction}><input type="hidden" name="organizationId" value={organizationId ?? ""} /><input type="hidden" name="sessionId" value={item.id} /><button type="submit">Revoke session</button></form>}
            </li>)}</ul>}
            {sessions.some((item) => !item.current) && <form action={revokeOtherSessionsAction} className={settings.form}>
              <input type="hidden" name="organizationId" value={organizationId ?? ""} />
              <label className={settings.confirmation}><input type="checkbox" name="confirmed" required />Sign out all other devices for this account.</label>
              <button type="submit">Revoke all other sessions</button>
            </form>}
          </>}
        </article>
        <article className={`${styles.panel} ${styles.span12}`}>
          <h2 className={styles.panelTitle}>Appearance</h2>
          <p className={styles.panelText}>Choose Dark or Light for this account. Your preference is saved with your sign-in.</p>
          <ThemeToggle initialTheme={appearance} />
        </article>
        <article className={`${styles.panel} ${styles.span12}`}>
          <h2 className={styles.panelTitle}>Email notifications</h2>
          <p className={styles.panelText}>In-app updates stay on. Choose whether to receive transactional order and Support updates by email. This setting is separate from the optional newsletter.</p>
          <form action={saveNotificationPreference} className={settings.form}>
            <input type="hidden" name="organizationId" value={organizationId ?? ""} />
            <label htmlFor="transactionalEmailEnabled">Transactional email</label>
            <select id="transactionalEmailEnabled" name="transactionalEmailEnabled" defaultValue={emailNotificationsEnabled ? "true" : "false"}>
              <option value="true">Send me order and Support updates</option>
              <option value="false">Do not send me transactional updates by email</option>
            </select>
            <button type="submit">Save email preference</button>
          </form>
        </article>
        <article className={`${styles.panel} ${styles.span12}`}>
          <h2 className={styles.panelTitle}>Optional newsletter</h2>
          <p className={styles.panelText}>This separate choice records whether you want occasional GPHKM product and service updates by email. You can opt out at any time. It does not affect transactional order or Support updates. Newsletter delivery is not enabled in this local build.</p>
          {!newsletterPreference.configured && <p className={settings.notice}>The newsletter consent notice version is not configured, so new opt-ins are unavailable.</p>}
          <form action={saveNewsletterPreference} className={settings.form}>
            <input type="hidden" name="organizationId" value={organizationId ?? ""} />
            <label htmlFor="newsletterSubscribed">Newsletter choice</label>
            <select id="newsletterSubscribed" name="newsletterSubscribed" defaultValue={newsletterPreference.subscribed ? "true" : "false"}>
              <option value="true" disabled={!newsletterPreference.configured && !newsletterPreference.subscribed}>I agree to receive occasional GPHKM updates</option>
              <option value="false">Do not send me newsletter updates</option>
            </select>
            <button type="submit">Save newsletter choice</button>
          </form>
          {newsletterPreference.noticeVersion && <p className={styles.panelText}>Consent record version: {newsletterPreference.noticeVersion}{newsletterPreference.updatedAt ? ` · updated ${newsletterPreference.updatedAt.toLocaleString()}` : ""}</p>}
        </article>
        <article className={`${styles.panel} ${styles.span12}`}>
          <h2 className={styles.panelTitle}>Terms and privacy history</h2>
          <p className={styles.panelText}>Your saved acceptance records are private to your account. You may need to accept a new version before placing orders or adding funds.</p>
          {!legalHistory.length ? <p className={styles.panelText}>No acceptance record is available for this account yet.</p> : <ul className={settings.members}>{legalHistory.map((record) => <li className={settings.member} key={`${record.termsVersion}:${record.privacyVersion}:${record.acceptedAt.toISOString()}`}>
            <div><strong>Accepted {record.acceptedAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</strong><p>Terms: {record.termsVersion}</p><p>Privacy: {record.privacyVersion}</p></div>
          </li>)}</ul>}
        </article>
        <article className={`${styles.panel} ${styles.span12}`}><h2 className={styles.panelTitle}>Account links</h2><div className={settings.links}><Link href={`/customer/orders${suffix}`}>Your orders</Link><Link href={`/customer/wallet${suffix}`}>Organization wallet</Link><Link href={`/customer/support${suffix}`}>Support requests</Link>{documents && <><a href={documents.termsUrl} target="_blank" rel="noopener noreferrer">Terms ({documents.termsVersion})</a><a href={documents.privacyUrl} target="_blank" rel="noopener noreferrer">Privacy ({documents.privacyVersion})</a></>}</div></article>
      </section>
    </>
  );
}
