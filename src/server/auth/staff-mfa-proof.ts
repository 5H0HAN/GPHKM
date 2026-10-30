import "server-only";
import { sql } from "drizzle-orm";
import { getMfaProofDb } from "@/db/mfa-proof";
import { getAuthForSurface } from "./index";
import { mergeSessionCookies } from "./session-cookies";

const verificationPaths = new Map<string, "TOTP" | "BACKUP_CODE" | "OTP">([
  ["/api/auth/two-factor/verify-totp", "TOTP"],
  ["/api/auth/two-factor/verify-backup-code", "BACKUP_CODE"],
  ["/api/auth/two-factor/verify-otp", "OTP"],
]);

/**
 * Persist proof only after Better Auth returns a successful MFA verification and
 * the resulting/current cookie resolves to the exact database session. A session
 * lookup or proof write failure must prevent the response from issuing a usable
 * staff session.
 */
export async function recordStaffMfaProof(request: Request, response: Response): Promise<Response> {
  const path = new URL(request.url).pathname;
  const method = verificationPaths.get(path);
  if (!method || !response.ok) return response;

  const result = await response.clone().json().catch(() => null) as { status?: unknown; token?: unknown; user?: unknown } | null;
  if (!result || result.status === false || (result.status !== true && typeof result.token !== "string")) return response;

  const cookie = mergeSessionCookies(request.headers.get("cookie") ?? "", response.headers.getSetCookie());
  if (!cookie) throw new Error("MFA verification session unavailable");
  const headers = new Headers(request.headers);
  headers.set("cookie", cookie);
  const authenticated = await getAuthForSurface("staff").api.getSession({ headers });
  if (!authenticated) throw new Error("MFA verification session unavailable");

  if (!("twoFactorEnabled" in authenticated.user) || !authenticated.user.twoFactorEnabled) {
    throw new Error("MFA verification session unavailable");
  }
  const mfaDb = getMfaProofDb();
  await mfaDb.execute(sql`select public.gphkm_record_staff_mfa_proof(
    ${authenticated.user.id}, ${authenticated.session.id}, ${method})`);
  return response;
}
