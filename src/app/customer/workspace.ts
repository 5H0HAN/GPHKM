import "server-only";
import { cookies, headers } from "next/headers";
import { listMyOrganizations, requireVerifiedCustomer } from "@/server/identity/customer-context";
import { ACTIVE_ORGANIZATION_COOKIE, chooseOrganizationId, preferOrganization } from "@/modules/identity/organizations";

export async function loadCustomerWorkspace() {
  const requestHeaders = await headers();
  try {
    const customer = await requireVerifiedCustomer(requestHeaders);
    const organizations = preferOrganization(await listMyOrganizations(requestHeaders), (await cookies()).get(ACTIVE_ORGANIZATION_COOKIE)?.value);
    return { authenticated: true as const, customer, organizations };
  } catch {
    return { authenticated: false as const, customer: null, organizations: [] };
  }
}

export function selectedOrganizationId(
  organizations: Array<{ id: string }>,
  requestedId?: string,
): string | null {
  return chooseOrganizationId(organizations, requestedId);
}
