import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { hashPassword } from "better-auth/crypto";
import { Client } from "pg";
import { assertLoopbackUrl, localAuthEnabled, localStaffMfaDisabled, requiredEnv } from "../src/server/auth/policy.ts";
import { mergeSessionCookies } from "../src/server/auth/session-cookies.ts";
import { authSurfaceOrigins } from "../src/server/auth/surfaces.ts";

if (process.env.NODE_ENV !== "development" || !localAuthEnabled(process.env) || !localStaffMfaDisabled(process.env)) {
  throw new Error("This check requires development auth with the explicit local staff MFA bypass");
}

const origins = authSurfaceOrigins(process.env);
const migrationUrl = assertLoopbackUrl(requiredEnv(process.env, "MIGRATION_DATABASE_URL"), "MIGRATION_DATABASE_URL");
if (!["postgres:", "postgresql:"].includes(migrationUrl.protocol) ||
    decodeURIComponent(migrationUrl.username) !== "gphkm_migration" || migrationUrl.pathname !== "/gphkm") {
  throw new Error("This check requires the local GPHKM migration database");
}

const db = new Client({ connectionString: migrationUrl.toString() });
const userId = randomUUID();
const email = `staff-auth-check-${userId}@gphkm.test`;
const password = `${randomUUID()}Aa1!`;
const inviterUserId = randomUUID();
const inviteId = randomUUID();
const inviteToken = randomBytes(32).toString("base64url");
const inviteEmail = `staff-invite-check-${inviteId}@gphkm.test`;
const invitePassword = `${randomUUID()}Aa1!`;
let cookie = "";
let userCreated = false;
let inviterCreated = false;
let invitationCreated = false;
let invitedUserId: string | undefined;
let stage = "connecting to the local migration database";
let lastStatus: number | undefined;

async function request(surface: "customer" | "staff", path: string, body?: unknown, forwardCookie = true, extraHeaders: Record<string, string> = {}) {
  const origin = new URL(origins[surface]);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const transport = origin.protocol === "https:" ? httpsRequest : httpRequest;
  const response = await new Promise<Response>((resolve, reject) => {
    const req = transport({
      // .localhost names do not always resolve outside a browser. Keep the
      // socket on loopback, but route and check CSRF against the real origin.
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
        ...(cookie && forwardCookie ? { cookie } : {}),
        ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
      },
    }, (res) => {
      const headers = new Headers();
      for (let index = 0; index < res.rawHeaders.length; index += 2) {
        headers.append(res.rawHeaders[index], res.rawHeaders[index + 1]);
      }
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
  const issued = response.headers.getSetCookie();
  if (issued.some((value) => /;\s*domain=/i.test(value))) throw new Error("Expected host-only auth cookies");
  if (surface === "staff") cookie = mergeSessionCookies(cookie, issued);
  return response;
}

function assertRedirectToSignIn(response: Response) {
  const location = response.headers.get("location");
  if (response.status !== 307 || !location || new URL(location, origins.staff).pathname !== "/staff/sign-in") {
    throw new Error("Expected a redirect to staff sign-in");
  }
}

try {
  await db.connect();

  stage = "staff signup with missing invitation header";
  const publicSignup = await request("staff", "/api/auth/sign-up/email", { name: "Temporary MFA check", email, password });
  const signupError = await publicSignup.json() as { code?: unknown };
  if (publicSignup.status !== 403 || signupError.code !== "STAFF_INVITATION_REQUIRED") {
    throw new Error("Expected invite-bound staff signup");
  }
  const strayUser = await db.query("SELECT 1 FROM auth_user WHERE email=$1", [email]);
  if (strayUser.rowCount !== 0) throw new Error("Staff signup created an unexpected user");

  stage = "creating an expiring invitation for a temporary local identity";
  await db.query("INSERT INTO auth_user(id,name,email,email_verified) VALUES ($1,'Temporary invitation issuer',$2,true)", [inviterUserId, `staff-invite-issuer-${inviteId}@gphkm.test`]);
  inviterCreated = true;
  const inviteHash = createHash("sha256").update(inviteToken, "utf8").digest("hex");
  await db.query(
    "INSERT INTO staff_invitation(id,email,role,token_hash,status,invited_by_user_id,expires_at) VALUES ($1,$2,'ADMIN',$3,'PENDING',$4,now()+interval '7 days')",
    [inviteId, inviteEmail, inviteHash, inviterUserId],
  );
  invitationCreated = true;

  stage = "staff signup with a valid invitation";
  cookie = "";
  const invitedSignup = await request("staff", "/api/auth/sign-up/email", {
    name: "Temporary invited staff",
    email: inviteEmail,
    password: invitePassword,
  }, false, { "x-gphkm-staff-invitation-token": inviteToken });
  const invitedSignupBody = await invitedSignup.json() as { user?: { id?: unknown; email?: unknown; emailVerified?: unknown } };
  if (typeof invitedSignupBody.user?.id === "string") invitedUserId = invitedSignupBody.user.id;
  if (!invitedSignup.ok || typeof invitedSignupBody.user?.id !== "string"
      || invitedSignupBody.user.email !== inviteEmail || invitedSignupBody.user.emailVerified !== true) {
    throw new Error("A valid staff invitation did not create a verified account");
  }
  const invitedSession = await request("staff", "/api/auth/get-session");
  const invitedSessionBody = await invitedSession.json() as { session?: { userId?: unknown } } | null;
  if (!invitedSession.ok || invitedSessionBody?.session?.userId !== invitedUserId) {
    throw new Error("Valid staff invitation signup did not create its first session");
  }
  const beforeAcceptance = await db.query(
    "SELECT u.email_verified, s.active FROM auth_user u LEFT JOIN staff_account s ON s.user_id=u.id WHERE u.id=$1",
    [invitedUserId],
  );
  if (beforeAcceptance.rowCount !== 1 || beforeAcceptance.rows[0].email_verified !== true || beforeAcceptance.rows[0].active !== null) {
    throw new Error("Invited staff signup created a staff account before invitation acceptance");
  }

  stage = "accepting the staff invitation on the staff surface";
  const acceptance = await request("staff", "/api/staff/invitations/accept", { token: inviteToken });
  if (!acceptance.ok || (await acceptance.json() as { accepted?: unknown }).accepted !== true) {
    throw new Error("Valid staff invitation could not be accepted");
  }
  const acceptedStaff = await db.query(
    "SELECT s.role, s.active, i.status, i.accepted_by_user_id FROM staff_account s JOIN staff_invitation i ON i.id=$2 WHERE s.user_id=$1",
    [invitedUserId, inviteId],
  );
  if (acceptedStaff.rowCount !== 1 || acceptedStaff.rows[0].role !== "ADMIN" || acceptedStaff.rows[0].active !== false
      || acceptedStaff.rows[0].status !== "ACCEPTED" || acceptedStaff.rows[0].accepted_by_user_id !== invitedUserId) {
    throw new Error("Staff invitation acceptance did not create an inactive invited account");
  }
  const acceptedAudit = await db.query(
    "SELECT 1 FROM audit_event WHERE actor_user_id=$1 AND action='staff.invitation_accepted' AND target_id=$2",
    [invitedUserId, inviteId],
  );
  if (acceptedAudit.rowCount !== 1) throw new Error("Staff invitation acceptance was not audited");
  assertRedirectToSignIn(await request("staff", "/staff"));

  stage = "cleaning the invitation flow before the local bypass sign-in check";
  await request("staff", "/api/auth/sign-out", {});
  cookie = "";

  stage = "creating a temporary local staff fixture";
  await db.query("INSERT INTO auth_user(id,name,email,email_verified) VALUES ($1,$2,$3,true)", [userId, "Temporary staff auth check", email]);
  userCreated = true;
  await db.query(
    "INSERT INTO auth_account(id,account_id,provider_id,user_id,password) VALUES ($1,$2,'credential',$2,$3)",
    [randomUUID(), userId, await hashPassword(password)],
  );
  await db.query("INSERT INTO staff_account(user_id,role,active) VALUES ($1,'ADMIN',true)", [userId]);

  stage = "local bypass staff access";
  const signIn = () => request("staff", "/api/auth/sign-in/email", { email, password, callbackURL: "/staff" });
  if (!(await signIn()).ok) throw new Error("Temporary staff sign-in did not succeed");
  if ((await request("staff", "/staff")).status !== 200) throw new Error("Expected password-only staff console access");

  stage = "customer rejects a forwarded staff cookie";
  const customerSignIn = await request("customer", "/sign-in");
  if (customerSignIn.status !== 200 || (await customerSignIn.text()).includes(email)) {
    throw new Error("Staff identity leaked into customer sign-in");
  }
  const customerWorkspace = await request("customer", "/customer/settings");
  const workspace = await customerWorkspace.text();
  if (customerWorkspace.status !== 200 || workspace.includes(email) || !workspace.includes("Sign in or create an account")) {
    throw new Error("Staff identity leaked into the customer workspace");
  }

  stage = "staff password sign-out and repeat sign-in";
  if (!(await request("staff", "/api/auth/sign-out", {})).ok) throw new Error("Temporary staff sign-out did not succeed");
  if (!(await signIn()).ok) throw new Error("Temporary staff sign-in did not succeed after sign-out");
  if ((await request("staff", "/staff")).status !== 200) throw new Error("Expected verified staff console access");

  console.log("Local staff auth check passed. Verified invite-bound signup and acceptance, the explicit development MFA bypass, staff access control, and rejection of forwarded staff cookies.");
} catch {
  console.error(`Local staff auth check failed during ${stage}${lastStatus === undefined ? "" : ` (last HTTP status ${lastStatus})`}`);
  process.exitCode = 1;
} finally {
  if (invitationCreated) {
    try { await db.query("DELETE FROM staff_invitation WHERE id=$1", [inviteId]); }
    catch {
      console.error("Temporary invitation cleanup failed");
      process.exitCode = 1;
    }
  }
  if (invitationCreated || invitedUserId) {
    try {
      const inviteeId = invitedUserId ?? (await db.query<{ id: string }>(
        "SELECT id FROM auth_user WHERE email=$1",
        [inviteEmail],
      )).rows[0]?.id;
      if (inviteeId) {
        await db.query("DELETE FROM auth_verification WHERE value=$1", [inviteeId]);
        await db.query("DELETE FROM auth_session WHERE user_id=$1", [inviteeId]);
        await db.query("DELETE FROM auth_account WHERE user_id=$1", [inviteeId]);
        await db.query("DELETE FROM auth_two_factor WHERE user_id=$1", [inviteeId]);
        await db.query("DELETE FROM staff_account WHERE user_id=$1", [inviteeId]);
        const acceptanceAudit = await db.query(
          "SELECT 1 FROM audit_event WHERE actor_user_id=$1 AND action='staff.invitation_accepted' AND target_id=$2",
          [inviteeId, inviteId],
        );
        if (acceptanceAudit.rowCount === 0) await db.query("DELETE FROM auth_user WHERE id=$1", [inviteeId]);
        // Successful acceptance is immutable audit evidence. Retain only its
        // inert synthetic identity so the actor reference remains valid.
      }
    } catch {
      console.error("Temporary invitee credential cleanup failed");
      process.exitCode = 1;
    }
  }
  if (inviterCreated) {
    try { await db.query("DELETE FROM auth_user WHERE id=$1", [inviterUserId]); }
    catch {
      console.error("Temporary invitation issuer cleanup failed");
      process.exitCode = 1;
    }
  }
  if (userCreated) {
    try {
      await db.query("DELETE FROM auth_verification WHERE value=$1", [userId]);
      await db.query("DELETE FROM staff_account WHERE user_id=$1", [userId]);
      await db.query("DELETE FROM auth_user WHERE id=$1", [userId]);
    } catch {
      console.error("Temporary staff fixture cleanup failed");
      process.exitCode = 1;
    }
  }
  await db.end().catch(() => {});
}
