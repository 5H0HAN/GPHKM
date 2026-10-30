import Link from "next/link";
import type { ReactNode } from "react";
import { OrganizationSwitcher } from "./organization-switcher";
import { WorkspaceNav } from "./workspace-nav";
import styles from "./customer.module.css";
import { loadCustomerWorkspace } from "./workspace";
import { OrganizationOnboarding } from "./organization-onboarding";
import { TrialBanner } from "./trial-banner";
import { getMarketplaceAccess } from "@/server/wallet/read";
import { headers } from "next/headers";
import { getCustomerLegalState } from "@/server/legal/consent";
import { CustomerLegalAcceptance } from "./legal-acceptance";
import { readAppearancePreference } from "@/server/identity/appearance";
import { CustomerSignOut } from "./customer-signout";

export default async function CustomerLayout({ children }: { children: ReactNode }) {
  const workspace = await loadCustomerWorkspace();

  if (!workspace.authenticated) {
    return (
        <main className={styles.frame}>
        <div className={`${styles.content} ${styles.publicContent}`}>
          <Link className={styles.brand} href="/">
            <span className={styles.brandMark}>G</span> GPHKM
          </Link>
          <p className={styles.navLabel}>Customer marketplace</p>
          <h1 className={styles.title}>Find a placement for your next story.</h1>
          <p className={styles.subtitle}>
            Browse reviewed websites, place orders for your organization, and follow progress from your workspace.
          </p>
          <ul className={styles.accessList}>
            <li>Sign in with a verified account to browse listings.</li>
            <li>Set up an organization to keep team orders and wallet activity together.</li>
            <li>See clear order milestones and customer-safe updates.</li>
          </ul>
          <Link className={styles.panelAction} href="/sign-in">Sign in or create an account</Link>
        </div>
      </main>
    );
  }

  const appearance = await readAppearancePreference(workspace.customer.userId);

  let legal: Awaited<ReturnType<typeof getCustomerLegalState>> | null = null;
  try { legal = await getCustomerLegalState(await headers()); } catch { /* Legal setup should block protected actions, not account access. */ }

  if (!workspace.organizations.length) {
    if (!legal) {
      return <main className={styles.frame} data-theme={appearance.toLowerCase()}><div className={`${styles.content} ${styles.emptyContent}`}><h1 className={styles.title}>Organization setup is unavailable</h1><p className={styles.subtitle}>The current Terms and Privacy documents are not configured. Account sign-in remains available; organization setup and protected actions are temporarily unavailable.</p><Link href="/sign-in">Manage your sign-in</Link><CustomerSignOut /></div></main>;
    }
    return (
      <main className={styles.frame} data-theme={appearance.toLowerCase()}>
        <div className={`${styles.content} ${styles.emptyContent}`}>
          <Link className={styles.brand} href="/customer">
            <span className={styles.brandMark}>G</span> GPHKM
          </Link>
          <OrganizationOnboarding documents={legal.documents} />
          <CustomerSignOut />
        </div>
      </main>
    );
  }

  const requestHeaders = await headers();
  const accessByOrganization = await Promise.all(workspace.organizations.map(async (organization) => {
    try {
      const access = await getMarketplaceAccess(requestHeaders, organization.id);
      return {
        organizationId: organization.id,
        paidAccessActive: access.paidAccessActive,
        trialEndsAt: access.trialEndsAt.toISOString(),
      };
    } catch {
      return null;
    }
  }));
  return (
    <div className={styles.frame} data-theme={appearance.toLowerCase()}>
      <div className={styles.layout}>
        <a className={styles.skipLink} href="#customer-main">Skip to main content</a>
        <aside className={styles.rail} aria-label="Customer workspace">
          <Link className={styles.brand} href="/customer">
            <span className={styles.brandMark} aria-hidden="true">G</span>
            <span>GPHKM</span>
          </Link>
          <p className={styles.navLabel}>Workspace</p>
          <WorkspaceNav organizations={workspace.organizations} />
          <div className={styles.railBottom}>
            <span className={styles.accountLabel} title={workspace.customer.email}>{workspace.customer.email}</span>
            <CustomerSignOut />
          </div>
        </aside>
        <main className={styles.main} id="customer-main">
          <header className={styles.topbar}>
            <span className={styles.crumb}>Customer workspace</span>
            {workspace.organizations.length ? <OrganizationSwitcher organizations={workspace.organizations} /> : <span className={styles.quiet}>No organization yet</span>}
          </header>
          <TrialBanner organizations={accessByOrganization.filter((access) => access !== null)} />
          {!legal && <div className={styles.error} role="alert">The current Terms and Privacy documents could not be loaded. Protected organization actions remain unavailable. You can still use account settings and view your acceptance history.</div>}
          {legal && !legal.accepted && <CustomerLegalAcceptance documents={legal.documents} />}
          <div className={styles.content}>{children}</div>
        </main>
      </div>
    </div>
  );
}
