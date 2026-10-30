"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { chooseOrganizationId, organizationPath } from "@/modules/identity/organizations";
import { switchActiveOrganizationAction } from "./organization-actions";
import styles from "./customer.module.css";

type OrganizationOption = { id: string; name: string };

export function OrganizationSwitcher({ organizations }: { organizations: OrganizationOption[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selected = chooseOrganizationId(organizations, searchParams.get("organizationId")) ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (organizations.length <= 1) return <span className={styles.orgSelect}>{organizations[0]?.name ?? "No organization yet"}</span>;

  return (
    <div><label className={styles.switcherLabel}>
      <span className={styles.srOnly}>Current organization</span>
      <select className={styles.orgSelect} value={selected} disabled={busy} onChange={async (event) => {
        const organizationId = event.currentTarget.value;
        setBusy(true); setError("");
        try {
          await switchActiveOrganizationAction(organizationId);
          router.push(organizationPath(pathname, organizationId));
          router.refresh();
        } catch { setError("Organization could not be changed. Refresh and try again."); }
        finally { setBusy(false); }
      }}>
        {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
      </select>
    </label>{error && <p className={styles.panelText} role="alert">{error}</p>}</div>
  );
}
