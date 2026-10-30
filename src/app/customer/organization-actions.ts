"use server";
import { cookies, headers } from "next/headers";
import { ACTIVE_ORGANIZATION_COOKIE } from "@/modules/identity/organizations";
import { withOrganizationContext } from "@/server/identity/customer-context";

export async function switchActiveOrganizationAction(organizationId: string) {
  await withOrganizationContext(await headers(), organizationId, async () => undefined);
  (await cookies()).set(ACTIVE_ORGANIZATION_COOKIE, organizationId, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
  return { organizationId };
}
