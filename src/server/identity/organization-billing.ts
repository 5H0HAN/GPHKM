import "server-only";
import { eq, sql } from "drizzle-orm";
import { organizationBillingProfile } from "@/db/identity-schema";
import { normalizeBillingProfile, type BillingProfileInput } from "@/modules/identity/billing-profile";
import { withOrganizationContext, withProtectedOrganizationContext } from "./customer-context";

export async function getOrganizationBillingProfile(headers: Headers, organizationId: string) {
  return withOrganizationContext(headers, organizationId, async (tx, role) => {
    if (role !== "OWNER") return null;
    const [profile] = await tx.select({
      legalName: organizationBillingProfile.legalName,
      billingEmail: organizationBillingProfile.billingEmail,
      billingAddress: organizationBillingProfile.billingAddress,
      updatedAt: organizationBillingProfile.updatedAt,
    }).from(organizationBillingProfile).where(eq(organizationBillingProfile.organizationId, organizationId)).limit(1);
    return profile ?? { legalName: null, billingEmail: null, billingAddress: null, updatedAt: null };
  });
}

export async function updateOrganizationBillingProfile(headers: Headers, organizationId: string, input: BillingProfileInput) {
  const profile = normalizeBillingProfile(input);
  return withProtectedOrganizationContext(headers, organizationId, async (tx, role) => {
    if (role !== "OWNER") throw new Error("Forbidden");
    const { rows } = await tx.execute(sql`
      select public.gphkm_update_organization_billing_profile(
        ${organizationId}, ${profile.legalName}, ${profile.billingEmail}, ${profile.billingAddress}
      ) as changed
    `);
    return (rows[0] as { changed: boolean } | undefined)?.changed === true;
  });
}
