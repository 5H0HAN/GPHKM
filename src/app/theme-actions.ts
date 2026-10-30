"use server";

import { headers } from "next/headers";
import { requireStaffAccess } from "@/server/auth/staff";
import { resolveAuthSurface } from "@/server/auth/surfaces";
import { requireVerifiedCustomer } from "@/server/identity/customer-context";
import { saveAppearancePreference, type AppearanceTheme } from "@/server/identity/appearance";

export async function saveAppearanceTheme(value: string): Promise<boolean> {
  if (value !== "DARK" && value !== "LIGHT") return false;
  const requestHeaders = await headers();
  const surface = resolveAuthSurface(requestHeaders, process.env);
  try {
    const actor = surface === "customer"
      ? await requireVerifiedCustomer(requestHeaders)
      : surface === "staff"
        ? await requireStaffAccess(requestHeaders, "audit.read")
        : null;
    if (!actor) return false;
    await saveAppearancePreference(actor.userId, value as AppearanceTheme);
    return true;
  } catch {
    return false;
  }
}
