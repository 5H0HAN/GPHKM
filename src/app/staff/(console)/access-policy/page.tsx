import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { formatUsdMinorUnits } from "@/modules/wallet/usd-amount";
import { getAccessPolicy } from "@/server/wallet/access-policy";
import { updateAccessPolicyAction } from "./actions";
import styles from "./access-policy.module.css";

const durationLabels = { SIX_MONTHS: "Six calendar months", ONE_YEAR: "One calendar year", UNRESTRICTED: "Unrestricted" } as const;

export const dynamic = "force-dynamic";

export default async function AccessPolicyPage({ searchParams }: { searchParams: Promise<{ updated?: string; error?: string }> }) {
  const query = await searchParams;
  let policy: Awaited<ReturnType<typeof getAccessPolicy>>;
  try { policy = await getAccessPolicy(await headers()); }
  catch { redirect("/staff"); }
  return <>
    <header className={styles.header}><p className={styles.eyebrow}>SUPER ADMIN · CUSTOMER ACCESS</p><h1>Browsing access policy</h1>
      <p>Changes apply to future qualifying settled top-ups. Existing grants keep their recorded duration and expiry.</p></header>
    {query.updated && <p className={styles.success} role="status">Access policy updated and audited.</p>}
    {query.error && <p className={styles.error} role="alert">The policy was not changed. Check the values, reason, and latest policy version.</p>}
    <section className={styles.panel} aria-labelledby="current-policy">
      <h2 id="current-policy">Current policy</h2>
      <dl><div><dt>Minimum settled top-up</dt><dd>{"$"}{formatUsdMinorUnits(BigInt(policy.minimumMinor))} USD</dd></div>
        <div><dt>Access duration</dt><dd>{durationLabels[policy.duration as keyof typeof durationLabels]}</dd></div>
        <div><dt>Policy version</dt><dd>{policy.version}</dd></div>
        <div><dt>Last updated</dt><dd>{new Date(policy.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</dd></div></dl>
    </section>
    <section className={styles.panel} aria-labelledby="change-policy">
      <h2 id="change-policy">Set future grant policy</h2>
      <p>One settled wallet recharge at or above the minimum creates a separate grant. Wallet spending does not shorten access.</p>
      <form action={updateAccessPolicyAction} className={styles.form}>
        <input type="hidden" name="version" value={policy.version} />
        <label>Minimum recharge (USD)<input name="minimumUsd" type="number" min="0.01" step="0.01" defaultValue={formatUsdMinorUnits(BigInt(policy.minimumMinor))} required /></label>
        <label>Access duration<select name="duration" defaultValue={policy.duration}>
          <option value="SIX_MONTHS">Six calendar months</option><option value="ONE_YEAR">One calendar year</option><option value="UNRESTRICTED">Unrestricted</option>
        </select></label>
        <label>Reason for change<textarea name="reason" minLength={10} maxLength={500} required /></label>
        <label className={styles.confirm}><input type="checkbox" name="confirmed" required /> I confirm this platform-wide change applies to future grants only.</label>
        <button type="submit">Save policy</button>
      </form>
    </section>
  </>;
}
