import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { Client } from "pg";
import { assertLoopbackUrl, localAuthEnabled, localStaffMfaDisabled, requiredEnv, requiredMfaProofDatabaseUrl } from "../src/server/auth/policy.ts";
import { mergeSessionCookies } from "../src/server/auth/session-cookies.ts";
import { authSurfaceOrigins } from "../src/server/auth/surfaces.ts";

if (process.env.NODE_ENV !== "development" || !localAuthEnabled(process.env)
    || localStaffMfaDisabled(process.env)) {
  throw new Error("This check requires development auth and the MFA bypass turned off");
}

const origins = authSurfaceOrigins(process.env);
for (const [surface, origin] of Object.entries(origins)) {
  const url = assertLoopbackUrl(origin, surface.toUpperCase() + "_APP_URL");
  if (url.protocol !== "http:" || url.port !== "3001" || url.username || url.password) {
    throw new Error("This check requires customer and staff app origins on http port 3001");
  }
}
const databaseUrls = [
  { key: "DATABASE_URL", role: "gphkm_runtime" },
  { key: "MIGRATION_DATABASE_URL", role: "gphkm_migration" },
  { key: "MFA_PROOF_DATABASE_URL", role: "gphkm_mfa_proof" },
].map(({ key, role }) => {
  const raw = key === "MFA_PROOF_DATABASE_URL"
    ? requiredMfaProofDatabaseUrl(process.env)
    : requiredEnv(process.env, key);
  const url = assertLoopbackUrl(raw, key);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
      || url.username !== role || url.pathname !== "/gphkm_staff_mfa_check") {
    throw new Error("Auth check database URLs must use their expected roles and the gphkm_staff_mfa_check database");
  }
  return url;
});
const [runtimeUrl, migrationUrl, proofUrl] = databaseUrls;
if (databaseUrls.some((url) => url.hostname !== runtimeUrl.hostname || (url.port || "5432") !== (runtimeUrl.port || "5432"))) {
  throw new Error("All auth check database URLs must target the same loopback host and port");
}
if (proofUrl.href === runtimeUrl.href) throw new Error("The MFA proof connection must use its restricted database role");

const db = new Client({ connectionString: migrationUrl.toString() });
const fixtureId = randomUUID();
let userId: string | undefined;
const email = `staff-mfa-check-${fixtureId}@gphkm.test`;
const password = `${randomUUID()}Aa1!`;
const inviterUserId = randomUUID();
const invitationId = randomUUID();
const inviteToken = randomBytes(32).toString("base64url");
const cookies = new Map<"customer" | "staff", string>();
let inviterCreated = false;
let invitationCreated = false;
let userCreated = false;
let stage = "connecting to the isolated database";
let lastStatus: number | undefined;

async function request(surface: "customer" | "staff", path: string, body?: unknown, forwardedCookie?: string, extraHeaders: Record<string, string> = {}) {
  const origin = new URL(origins[surface]);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const transport = origin.protocol === "https:" ? httpsRequest : httpRequest;
  const currentCookie = forwardedCookie ?? cookies.get(surface) ?? "";
  const response = await new Promise<Response>((resolve, reject) => {
    const req = transport({
      hostname: origin.hostname.endsWith(".localhost") ? "127.0.0.1" : origin.hostname.replace(/^\[|\]$/g, ""),
      host: origin.host,
      port: origin.port,
      servername: origin.hostname,
      path,
      method: payload === undefined ? "GET" : "POST",
      headers: {
        host: origin.host,
        origin: origin.origin,
        ...extraHeaders,
        ...(currentCookie ? { cookie: currentCookie } : {}),
        ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
      },
    }, (res) => {
      const headers = new Headers();
      for (let index = 0; index < res.rawHeaders.length; index += 2) headers.append(res.rawHeaders[index], res.rawHeaders[index + 1]);
      res.setEncoding("utf8");
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("error", reject);
      res.on("end", () => {
        const status = res.statusCode ?? 500;
        resolve(new Response([204, 205, 304].includes(status) ? null : text, { status, headers }));
      });
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("Local HTTP request timed out")));
    req.end(payload);
  });
  lastStatus = response.status;
  const setCookies = response.headers.getSetCookie();
  if (setCookies.some((value) => /;\s*domain=/i.test(value))) throw new Error("Expected host-only auth cookies");
  if (forwardedCookie === undefined) cookies.set(surface, mergeSessionCookies(currentCookie, setCookies));
  return response;
}

function assertStaffSignInRedirect(response: Response) {
  const location = response.headers.get("location");
  if (response.status !== 307 || !location || new URL(location, origins.staff).pathname !== "/staff/sign-in") {
    throw new Error("Expected the staff page to reject the current session");
  }
}

async function deleteIfNoAuditEvidence(id: string) {
  const evidence = await db.query("SELECT 1 FROM audit_event WHERE actor_user_id=$1 OR target_id=$1 LIMIT 1", [id]);
  if (evidence.rowCount === 0) await db.query("DELETE FROM auth_user WHERE id=$1", [id]);
}

async function signIn() {
  const response = await request("staff", "/api/auth/sign-in/email", { email, password, callbackURL: "/staff/sign-in" });
  return { response, body: await response.json() as { twoFactorRedirect?: unknown } };
}

try {
  await db.connect();
  await db.query("INSERT INTO auth_user(id,name,email,email_verified) VALUES($1,'Temporary staff MFA inviter',$2,true)", [inviterUserId, `staff-mfa-inviter-${fixtureId}@gphkm.test`]);
  inviterCreated = true;
  await db.query("INSERT INTO staff_account(user_id,role,active) VALUES($1,'SUPER_ADMIN',true)", [inviterUserId]);
  const invitationHash = createHash("sha256").update(inviteToken, "utf8").digest("hex");
  await db.query(
    "INSERT INTO staff_invitation(id,email,role,token_hash,status,invited_by_user_id,expires_at) VALUES($1,$2,'ADMIN',$3,'PENDING',$4,now()+interval '7 days')",
    [invitationId, email, invitationHash, inviterUserId],
  );
  invitationCreated = true;

  stage = "creating and accepting an invited staff account";
  const signup = await request("staff", "/api/auth/sign-up/email", {
    name: "Temporary invited staff MFA check",
    email,
    password,
  }, undefined, { "x-gphkm-staff-invitation-token": inviteToken });
  const signupBody = await signup.json() as { user?: { id?: unknown; email?: unknown; emailVerified?: unknown } };
  if (typeof signupBody.user?.id !== "string") throw new Error("Invited staff signup did not return an identity");
  userId = signupBody.user.id;
  userCreated = true;
  assert.equal(signup.status, 200);
  assert.equal(signupBody.user.email, email);
  assert.equal(signupBody.user.emailVerified, true);
  const acceptance = await request("staff", "/api/staff/invitations/accept", { token: inviteToken });
  assert.equal(acceptance.status, 200);
  assert.equal((await acceptance.json() as { accepted?: unknown }).accepted, true);
  const pendingStaff = await db.query<{ active: boolean }>("SELECT active FROM staff_account WHERE user_id=$1", [userId]);
  assert.equal(pendingStaff.rows[0]?.active, false);
  assertStaffSignInRedirect(await request("staff", "/staff"));

  stage = "enrolling and verifying TOTP";
  const setupResponse = await request("staff", "/api/auth/two-factor/enable", { method: "totp", password, issuer: "GPHKM Staff" });
  assert.equal(setupResponse.status, 200);
  const setup = await setupResponse.json() as { method?: unknown; totpURI?: unknown; backupCodes?: unknown };
  assert.equal(setup.method, "totp");
  assert.equal(typeof setup.totpURI, "string");
  assert.ok(Array.isArray(setup.backupCodes) && setup.backupCodes.length >= 1);
  const backupCode = setup.backupCodes[0] as string;
  const secret = new URL(setup.totpURI as string).searchParams.get("secret");
  if (!secret) throw new Error("Authenticator setup was incomplete");
  const authenticator = createOTP(base32.decode(secret), { period: 30, digits: 6 });
  const totpResponse = await request("staff", "/api/auth/two-factor/verify-totp", { code: await authenticator.totp(), trustDevice: false });
  assert.equal(totpResponse.status, 200);

  stage = "checking session-bound TOTP proof";
  const firstSessionResponse = await request("staff", "/api/auth/get-session");
  const firstSession = await firstSessionResponse.json() as { session?: { id?: unknown }; user?: { twoFactorEnabled?: unknown } };
  assert.equal(typeof firstSession.session?.id, "string");
  assert.equal(firstSession.user?.twoFactorEnabled, true);
  const firstProof = await db.query("SELECT method FROM staff_mfa_session WHERE session_id=$1 AND user_id=$2", [firstSession.session?.id, userId]);
  assert.equal(firstProof.rows[0]?.method, "TOTP");
  const verifiedPending = await db.query<{ active: boolean; factor_verified: boolean }>(
    "SELECT s.active, EXISTS (SELECT 1 FROM auth_two_factor f WHERE f.user_id=s.user_id AND f.verified) AS factor_verified FROM staff_account s WHERE s.user_id=$1",
    [userId],
  );
  assert.equal(verifiedPending.rows[0]?.active, false);
  assert.equal(verifiedPending.rows[0]?.factor_verified, true);
  assertStaffSignInRedirect(await request("staff", "/staff"));

  stage = "activating the invitee after verified TOTP enrollment";
  await db.query("BEGIN");
  try {
    await db.query("SELECT set_config('app.user_id',$1,true)", [inviterUserId]);
    await db.query("SELECT public.gphkm_activate_staff($1)", [userId]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
  const activated = await db.query<{ active: boolean }>("SELECT active FROM staff_account WHERE user_id=$1", [userId]);
  assert.equal(activated.rows[0]?.active, true);
  // Activation revokes the enrollment session; challenge checks start fresh.
  cookies.set("staff", "");

  stage = "enforcing password then TOTP on the next sign-in";
  const challenge = await signIn();
  assert.equal(challenge.response.status, 200);
  assert.equal(challenge.body.twoFactorRedirect, true);
  assert.equal(await (await request("staff", "/api/auth/get-session")).json(), null);
  const challengeTotp = await request("staff", "/api/auth/two-factor/verify-totp", { code: await authenticator.totp(), trustDevice: false });
  assert.equal(challengeTotp.status, 200);
  const verifiedSessionResponse = await request("staff", "/api/auth/get-session");
  const verifiedSession = await verifiedSessionResponse.json() as { session?: { id?: unknown }; user?: { twoFactorEnabled?: unknown } };
  assert.notEqual(verifiedSession.session?.id, firstSession.session?.id);
  const verifiedProof = await db.query("SELECT method FROM staff_mfa_session WHERE session_id=$1 AND user_id=$2", [verifiedSession.session?.id, userId]);
  assert.equal(verifiedProof.rows[0]?.method, "TOTP");
  assert.equal((await request("staff", "/staff")).status, 200);

  await new Promise((resolve) => setTimeout(resolve, 10_500));
  stage = "verifying one-time backup code sign-in";
  assert.equal((await request("staff", "/api/auth/sign-out", {})).status, 200);
  const backupChallenge = await signIn();
  assert.equal(backupChallenge.body.twoFactorRedirect, true);
  const backupResponse = await request("staff", "/api/auth/two-factor/verify-backup-code", { code: backupCode, trustDevice: false });
  assert.equal(backupResponse.status, 200);
  const backupSessionResponse = await request("staff", "/api/auth/get-session");
  const backupSession = await backupSessionResponse.json() as { session?: { id?: unknown } };
  const backupProof = await db.query("SELECT method FROM staff_mfa_session WHERE session_id=$1 AND user_id=$2", [backupSession.session?.id, userId]);
  assert.equal(backupProof.rows[0]?.method, "BACKUP_CODE");

  stage = "denying a valid session after its exact proof is removed";
  await db.query("DELETE FROM staff_mfa_session WHERE session_id=$1 AND user_id=$2", [backupSession.session?.id, userId]);
  assertStaffSignInRedirect(await request("staff", "/staff"));

  stage = "rejecting the forwarded staff cookie on the customer host";
  const crossSurface = await request("customer", "/customer/settings", undefined, cookies.get("staff"));
  const customerPage = await crossSurface.text();
  assert.equal(crossSurface.status, 200);
  assert.equal(customerPage.includes(email), false);
  assert.ok(customerPage.includes("Sign in or create an account"));

  console.log("Local staff MFA check passed: invited TOTP enrollment before activation, password challenge, backup code, exact-session proof, and customer/staff isolation.");
} catch {
  console.error(`Local staff MFA check failed during ${stage}${lastStatus === undefined ? "" : ` (HTTP ${lastStatus})`}`);
  process.exitCode = 1;
} finally {
  if (invitationCreated) {
    await db.query("DELETE FROM staff_invitation WHERE id=$1", [invitationId]).catch(() => {
      console.error("Temporary staff invitation cleanup failed");
      process.exitCode = 1;
    });
  }
  if (userCreated && userId) {
    const cleanupUserId = userId;
    await db.query("DELETE FROM auth_verification WHERE value=$1", [cleanupUserId])
      .then(() => db.query("DELETE FROM auth_session WHERE user_id=$1", [cleanupUserId]))
      .then(() => db.query("DELETE FROM auth_account WHERE user_id=$1", [cleanupUserId]))
      .then(() => db.query("DELETE FROM auth_two_factor WHERE user_id=$1", [cleanupUserId]))
      .then(() => db.query("DELETE FROM staff_account WHERE user_id=$1", [cleanupUserId]))
      .then(() => deleteIfNoAuditEvidence(cleanupUserId)).catch(() => {
      console.error("Temporary staff MFA fixture cleanup failed");
      process.exitCode = 1;
    });
  }
  if (inviterCreated) {
    await db.query("DELETE FROM staff_account WHERE user_id=$1", [inviterUserId])
      .then(() => deleteIfNoAuditEvidence(inviterUserId)).catch(() => {
      console.error("Temporary staff MFA inviter cleanup failed");
      process.exitCode = 1;
    });
  }
  // Invitation and activation audit rows keep their inert synthetic actors.
  await db.end().catch(() => {});
}
