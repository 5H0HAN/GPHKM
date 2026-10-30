"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { marketplaceTrialCountdown } from "@/modules/wallet/marketplace-trial";

type OrganizationAccess = {
  organizationId: string;
  paidAccessActive: boolean;
  trialEndsAt: string;
};

export function TrialBanner({ organizations }: { organizations: OrganizationAccess[] }) {
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("organizationId");
  const selected = organizations.find(({ organizationId }) => organizationId === selectedId) ?? organizations[0];
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const initialUpdate = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      window.clearTimeout(initialUpdate);
      window.clearInterval(timer);
    };
  }, []);

  if (!selected || selected.paidAccessActive) return null;
  const countdown = now === null ? null : marketplaceTrialCountdown(new Date(selected.trialEndsAt), now);

  return (
    <aside className="customerTrialBanner" aria-label="Marketplace browsing access">
      <p>
        <strong>{countdown?.expired ? "Your browsing access has ended." : "Complimentary marketplace access"}</strong>{" "}
        {countdown?.expired
          ? "Load the required minimum wallet amount to restore browsing and reveal eligible listing URLs."
          : <>Your trial {countdown ? <>ends in <span className="customerTrialCountdown">{countdown.days}d {countdown.hours}h {countdown.minutes}m</span></> : "countdown is updating"}. Load the required minimum wallet amount to keep browsing and reveal eligible listing URLs.</>}
      </p>
      <Link href={`/customer/wallet?organizationId=${encodeURIComponent(selected.organizationId)}`}>Load balance</Link>
    </aside>
  );
}
