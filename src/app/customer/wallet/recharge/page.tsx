import Link from "next/link";
import styles from "../../customer.module.css";
import { loadCustomerWorkspace, selectedOrganizationId } from "../../workspace";
import { TopUpCheckout } from "./topup-checkout";
import { isStripeWalletCheckoutAvailable } from "@/server/payments/stripe";

export const dynamic = "force-dynamic";

export default async function RechargePage({ searchParams }: { searchParams: Promise<{ organizationId?: string | string[]; session_id?: string | string[] }> }) {
  const workspace = await loadCustomerWorkspace();
  if (!workspace.authenticated) return null;
  const params = await searchParams;
  const organizationId = selectedOrganizationId(workspace.organizations, Array.isArray(params.organizationId) ? params.organizationId[0] : params.organizationId);
  const organization = workspace.organizations.find((org) => org.id === organizationId);
  if (!organizationId || !organization || organization.role !== "OWNER") {
    return <div className={styles.error}>Only an organization Owner can load wallet balance. Ask an Owner to continue.</div>;
  }
  const returnedFromProvider = typeof params.session_id === "string";

  return (
    <>
      <div className={styles.headingRow}>
        <div>
          <h1 className={styles.title}>Load wallet balance</h1>
          <p className={styles.subtitle}>Top-ups are made to your organization wallet and orders use those funds at checkout.</p>
        </div>
      </div>
      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Add funds to your organization wallet</h2>
        <p className={styles.panelText}>Payments are charged in USD. Your organization wallet is credited only after a verified payment confirmation.</p>
        <TopUpCheckout organizationId={organizationId} returnedFromProvider={returnedFromProvider} checkoutAvailable={isStripeWalletCheckoutAvailable()} />
        <Link className={styles.panelAction} href={`/customer/wallet?organizationId=${encodeURIComponent(organizationId)}`}>Return to wallet</Link>
      </section>
    </>
  );
}
