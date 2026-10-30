import "server-only";
import { headers } from "next/headers";
import { getAuthForSurface } from "@/server/auth";
import { resolveAuthSurface, type AuthSurface } from "@/server/auth/surfaces";
import { isStaffIdentity } from "./identity-domain";

export type SignInSession = {
  email: string;
  twoFactorEnabled: boolean;
} | null;

export async function getSignInSession(surface: AuthSurface): Promise<SignInSession> {
  const requestHeaders = await headers();
  if (resolveAuthSurface(requestHeaders, process.env) !== surface) return null;
  const authenticated = await getAuthForSurface(surface).api.getSession({ headers: requestHeaders });
  if (authenticated && (await isStaffIdentity(authenticated.user.id)) !== (surface === "staff")) return null;
  const twoFactorEnabled = authenticated && "twoFactorEnabled" in authenticated.user && authenticated.user.twoFactorEnabled === true;
  return authenticated ? {
    email: authenticated.user.email,
    twoFactorEnabled: twoFactorEnabled === true,
  } : null;
}
