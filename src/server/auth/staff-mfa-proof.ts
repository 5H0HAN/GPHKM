import "server-only";
import { sql } from "drizzle-orm";
import { getMfaProofDb } from "@/db/mfa-proof";
import { getAuthForSurface } from "./index";
import { mergeSessionCookies } from "./session-cookies";

const verificationPaths = new Map<string, "TOTP" | "BACKUP_CODE">([
  ["/api/auth/two-factor/verify-totp", "TOTP"],
  ["/api/auth/two-factor/verify-backup-code", "BACKUP_CODE"],
]);

/** Persist proof only for the exact session Better Auth returned after a valid factor check. */
export async function recordStaffMfaProof(request: Request, response: Response): Promise<Response> {
  const method = verificationPaths.get(new URL(request.url).pathname);
  if (!method || !response.ok) return response;

  const result = await response.clone().json().catch(() => null) as { status?: unknown; token?: unknown } | null;
  if (!result || result.status === false || (result.status !== true && typeof result.token !== "string")) return response;

  const cookie = mergeSessionCookies(request.headers.get("cookie") ?? "", response.headers.getSetCookie());
  if (!cookie) throw new Error("Staff MFA session unavailable");
  const headers = new Headers(request.headers);
  headers.set("cookie", cookie);
  const authenticated = await getAuthForSurface("staff").api.getSession({ headers });
  if (!authenticated || !("twoFactorEnabled" in authenticated.user) || authenticated.user.twoFactorEnabled !== true) {
    throw new Error("Staff MFA session unavailable");
  }

  await getMfaProofDb().execute(sql`select public.gphkm_record_staff_mfa_proof(
    ${authenticated.user.id}, ${authenticated.session.id}, ${method})`);
  return response;
}
