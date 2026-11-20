import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { Client } from "pg";
import { assertLoopbackUrl, customerSessionCreationAllowed, localAuthEnabled, requiredEnv } from "../src/server/auth/policy.ts";
import { mergeSessionCookies } from "../src/server/auth/session-cookies.ts";
import { authSurfaceOrigins } from "../src/server/auth/surfaces.ts";

if (process.env.NODE_ENV !== "development" || !localAuthEnabled(process.env)) {
  throw new Error("This check requires local development authentication");
}
const origins = authSurfaceOrigins(process.env);
const migrationUrl = assertLoopbackUrl(requiredEnv(process.env, "MIGRATION_DATABASE_URL"), "MIGRATION_DATABASE_URL");
if (!["postgres:", "postgresql:"].includes(migrationUrl.protocol) ||
  decodeURIComponent(migrationUrl.username) !== "gphkm_migration" || migrationUrl.pathname !== "/gphkm") {
  throw new Error("This check requires the disposable local GPHKM migration database");
}
const db = new Client({ connectionString: migrationUrl.toString() });
const newPassword = () => randomBytes(32).toString("base64url");
let stage = "connecting to the local migration database";

async function createUser(emailVerified = true, twoFactorEnabled = false) {
  const id = randomUUID();
  const email = `auth-recovery-${id}@gphkm.test`;
  await db.query(
    "INSERT INTO auth_user(id,name,email,email_verified,two_factor_enabled) VALUES($1,'Auth recovery fixture',$2,$3,$4)",
    [id, email, emailVerified, twoFactorEnabled],
  );
  return { id, email };
}

async function createStaff(role: "SUPER_ADMIN" | "ADMIN" | "FINANCE", active: boolean, verifiedTotp: boolean, verifiedEmail = true) {
  const staff = await createUser(verifiedEmail, verifiedTotp);
  await db.query("INSERT INTO staff_account(user_id,role,active) VALUES($1,$2,$3)", [staff.id, role, active]);
  if (verifiedTotp) await addTotp(staff.id, true);
  return staff;
}

async function addTotp(userId: string, verified: boolean) {
  // Limit direct factor fixtures to the rolled back database-only checks.
  await db.query(
    "INSERT INTO auth_two_factor(id,user_id,secret,backup_codes,verified) VALUES($1,$2,'fixture-only','fixture-only',$3)",
    [randomUUID(), userId, verified],
  );
}

async function addCredential(userId: string, password: string) {
  await db.query(
    "INSERT INTO auth_account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
    [randomUUID(), userId, await hashPassword(password)],
  );
}

async function addSessionProof(userId: string) {
  const sessionId = randomUUID();
  await db.query(
    "INSERT INTO auth_session(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [sessionId, userId, newPassword()],
  );
  await db.query("INSERT INTO staff_mfa_session(session_id,user_id,method) VALUES($1,$2,'TOTP')", [sessionId, userId]);
}

async function addVerification(identifier: string, userId: string) {
  await db.query(
    "INSERT INTO auth_verification(id,identifier,value,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
    [randomUUID(), identifier, userId],
  );
}

async function command(query: string, values: unknown[], actorId?: string, errorCode?: string) {
  await db.query("SAVEPOINT auth_recovery_command");
  if (actorId) {
    await db.query("SET LOCAL ROLE gphkm_runtime");
    await db.query("SELECT set_config('app.user_id',$1,true)", [actorId]);
  }
  if (errorCode) {
    await assert.rejects(db.query(query, values), (error: unknown) => {
      const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
      if (code !== errorCode && typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
        stage += ` (SQLSTATE ${code})`;
      }
      return code === errorCode;
    });
    await db.query("ROLLBACK TO SAVEPOINT auth_recovery_command");
  } else {
    await db.query(query, values);
  }
  if (actorId) await db.query("RESET ROLE");
  await db.query("RELEASE SAVEPOINT auth_recovery_command");
}

async function assertStaffState(userId: string, role: string, active: boolean) {
  const result = await db.query("SELECT role,active FROM staff_account WHERE user_id=$1", [userId]);
  assert.deepEqual(result.rows, [{ role, active }]);
}
async function assertAudit(action: string, target: string, actor: string | null, reason: string | null = null) {
  const result = await db.query(
    `SELECT 1 FROM audit_event WHERE action=$1 AND target_type='staff_account' AND target_id=$2
       AND actor_user_id IS NOT DISTINCT FROM $3 AND reason_code IS NOT DISTINCT FROM $4`,
    [action, target, actor, reason],
  );
  assert.equal(result.rowCount, 1);
}
async function assertRevoked(userId: string, factorCleared: boolean, twoFactorEnabled = !factorCleared) {
  const result = await db.query(
    `SELECT two_factor_enabled,
       EXISTS (SELECT 1 FROM auth_session WHERE user_id=$1) AS session,
       EXISTS (SELECT 1 FROM staff_mfa_session WHERE user_id=$1) AS proof,
       EXISTS (SELECT 1 FROM auth_two_factor WHERE user_id=$1) AS factor,
       EXISTS (SELECT 1 FROM auth_verification WHERE value=$1) AS verification
     FROM auth_user WHERE id=$1`,
    [userId],
  );
  assert.deepEqual(result.rows, [{
    two_factor_enabled: twoFactorEnabled,
    session: false,
    proof: false,
    factor: !factorCleared,
    verification: false,
  }]);
}

async function checkDatabaseRecovery() {
  const activate = "SELECT public.gphkm_activate_staff($1)";
  const promote = "SELECT public.gphkm_promote_super_admin($1,$2)";
  const recover = "SELECT public.gphkm_break_glass_recover_super_admin($1,$2,$3)";
  const reason = "LOCAL_RECOVERY_CHECK";
  let breakGlassSuccessSkipped = false;

  await db.query("BEGIN");
  try {
    stage = "database recovery fixture isolation";
    const passwordPeers = await db.query(`SELECT 1 FROM staff_account s JOIN auth_user u ON u.id=s.user_id
      WHERE s.active AND s.role='SUPER_ADMIN' AND u.email_verified AND u.two_factor_enabled
      AND EXISTS (SELECT 1 FROM auth_two_factor f WHERE f.user_id=u.id AND f.verified)
      AND EXISTS (SELECT 1 FROM auth_account a WHERE a.user_id=u.id
        AND a.provider_id='credential' AND a.password IS NOT NULL) LIMIT 1`);
    const existingPasswordPeer = (passwordPeers.rowCount ?? 0) > 0;
    const actor = await createStaff("SUPER_ADMIN", true, true);
    const pending = await createStaff("ADMIN", false, false);
    const unverified = await createStaff("ADMIN", false, true, false);
    const inactiveSuperAdmin = await createStaff("SUPER_ADMIN", false, true);
    const finance = await createStaff("FINANCE", true, true);
    stage = "staff activation requires verified email and TOTP";
    await command(activate, [pending.id], actor.id, "23514");
    await assertStaffState(pending.id, "ADMIN", false);
    await addTotp(pending.id, true);
    await db.query("UPDATE auth_user SET two_factor_enabled=true WHERE id=$1", [pending.id]);
    await addSessionProof(pending.id);
    await command(activate, [pending.id], actor.id);
    await assertStaffState(pending.id, "ADMIN", true);
    await assertRevoked(pending.id, false, true);
    await assertAudit("staff.activated", pending.id, actor.id);
    await command(activate, [unverified.id], actor.id, "23514");
    await command(activate, [actor.id], actor.id, "42501");
    await command(activate, [inactiveSuperAdmin.id], actor.id);
    await assertStaffState(inactiveSuperAdmin.id, "SUPER_ADMIN", true);
    await db.query("UPDATE staff_account SET active=false WHERE user_id=$1", [inactiveSuperAdmin.id]);

    stage = "Super Admin promotion requires verified email and TOTP";
    await command(promote, [pending.id, reason], finance.id, "42501");
    await command(promote, [finance.id, reason], actor.id, "23514");
    await command(promote, [unverified.id, reason], actor.id, "23514");
    await db.query("UPDATE staff_account SET active=true WHERE user_id=$1", [unverified.id]);
    await command(promote, [unverified.id, reason], actor.id, "23514");
    await addSessionProof(pending.id);
    await command(promote, [pending.id, reason], actor.id);
    await assertStaffState(pending.id, "SUPER_ADMIN", true);
    await assertRevoked(pending.id, false, true);
    await assertAudit("staff.super_admin_promoted", pending.id, actor.id, reason);

    stage = "second Super Admin TOTP reset revokes factor and sessions";
    const resetTarget = await createStaff("ADMIN", true, true);
    await addSessionProof(resetTarget.id);
    await command("SELECT public.gphkm_reset_staff_totp($1,$2)", [resetTarget.id, reason], actor.id);
    await assertRevoked(resetTarget.id, true, false);
    await assertAudit("staff.totp_reset", resetTarget.id, actor.id, reason);

    stage = "second Super Admin can reset an account before TOTP enrollment";
    const resetBeforeEnrollment = await createStaff("ADMIN", true, false);
    await addSessionProof(resetBeforeEnrollment.id);
    await command("SELECT public.gphkm_reset_staff_totp($1,$2)", [resetBeforeEnrollment.id, reason], actor.id);
    await assertRevoked(resetBeforeEnrollment.id, true, false);
    await assertAudit("staff.totp_reset", resetBeforeEnrollment.id, actor.id, reason);

    stage = "break-glass fixture password encoding";
    const password = newPassword();
    const hash = await hashPassword(password);
    await addCredential(inactiveSuperAdmin.id, newPassword());
    stage = "break-glass runtime role denial";
    await command(recover, [inactiveSuperAdmin.id, hash, reason], actor.id, "42501");
    stage = "break-glass service role grants";
    const grants = await db.query<{ allowed: boolean }>(
      `SELECT has_function_privilege(role_name, 'public.gphkm_break_glass_recover_super_admin(text,text,text)', 'EXECUTE') AS allowed
       FROM unnest(ARRAY['gphkm_runtime','gphkm_worker','gphkm_webhook','gphkm_resend_webhook','gphkm_mfa_proof']) AS role_name`,
    );
    assert.ok(grants.rows.every(({ allowed }) => !allowed));
    if (!existingPasswordPeer) {
      stage = "active TOTP-only peer without a password does not block break-glass recovery";
      const legacyOnlyTarget = await createStaff("SUPER_ADMIN", false, false);
      await command(recover, [legacyOnlyTarget.id, hash, reason]);
      await assertStaffState(legacyOnlyTarget.id, "SUPER_ADMIN", true);
      await db.query("UPDATE staff_account SET active=false WHERE user_id=$1", [legacyOnlyTarget.id]);
    }

    stage = "password-capable peer denial";
    let passwordPeer: { id: string } | undefined;
    if (!existingPasswordPeer) {
      passwordPeer = await createStaff("SUPER_ADMIN", true, true);
      await addCredential(passwordPeer.id, newPassword());
    }
    await command(recover, [inactiveSuperAdmin.id, hash, reason], undefined, "23514");
    stage = "break-glass sole active Super Admin fixture";
    await db.query("UPDATE staff_account SET active=false WHERE user_id=$1", [actor.id]);
    if (passwordPeer) await db.query("UPDATE staff_account SET active=false WHERE user_id=$1", [passwordPeer.id]);
    await db.query("UPDATE staff_account SET active=false WHERE user_id=$1", [inactiveSuperAdmin.id]);

    if (existingPasswordPeer) {
      stage = "existing password-capable Super Admin prevents break-glass";
      await command(recover, [inactiveSuperAdmin.id, hash, reason], undefined, "23514");
      breakGlassSuccessSkipped = true;
    } else {
      stage = "break-glass recovery, password hash, and anonymous audit";
      await addSessionProof(inactiveSuperAdmin.id);
      await addVerification(randomUUID(), inactiveSuperAdmin.id);
      await addVerification(randomUUID(), unverified.id);
      await command(recover, [inactiveSuperAdmin.id, hash, reason]);
      await assertStaffState(inactiveSuperAdmin.id, "SUPER_ADMIN", true);
      await assertRevoked(inactiveSuperAdmin.id, true);
      await assertAudit("staff.break_glass_recovered", inactiveSuperAdmin.id, null, reason);
      const stored = await db.query<{ password: string }>(
        "SELECT password FROM auth_account WHERE user_id=$1 AND provider_id='credential'",
        [inactiveSuperAdmin.id],
      );
      assert.ok(stored.rows[0]?.password && await verifyPassword({ hash: stored.rows[0].password, password }));
      assert.equal((await db.query("SELECT 1 FROM auth_verification WHERE value=$1", [unverified.id])).rowCount, 1);
    }
  } finally {
    await db.query("ROLLBACK");
  }
  return { breakGlassSuccessSkipped };
}

type AuthReply = {
  code?: string;
  method?: string;
  totpURI?: string;
  backupCodes?: string[];
  twoFactorRedirect?: boolean;
  session?: { id: string };
  user?: { id: string; twoFactorEnabled?: boolean };
} | null;

function authRequests(origin: string) {
  let cookie = "";
  return {
    hasSessionCookie: () => /(?:^|;\s*)[^=;]*\.session_token=[^;]+/.test(cookie),
    async request(path: string, body?: Record<string, unknown>) {
      const url = new URL(`/api/auth${path}`, origin);
      const payload = body === undefined ? undefined : JSON.stringify(body);
      // Node's DNS resolver does not necessarily resolve ".localhost" aliases.
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const response = await new Promise<{ status: number; body: AuthReply; cookies: string[] }>((resolve, reject) => {
        const req = send(url, {
          hostname: url.hostname === "[::1]" ? "::1" : "127.0.0.1",
          servername: url.hostname,
          method: payload === undefined ? "GET" : "POST",
          headers: {
            host: url.host,
            origin,
            ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
            ...(cookie ? { cookie } : {}),
          },
        }, (res) => {
          let decoded = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { decoded += chunk; });
          res.on("error", reject);
          res.on("end", () => {
            let body: AuthReply = null;
            try { body = JSON.parse(decoded) as AuthReply; } catch { /* A non-JSON response fails the assertion. */ }
            resolve({ status: res.statusCode ?? 0, body, cookies: res.headers["set-cookie"] ?? [] });
          });
        });
        req.on("error", reject);
        req.setTimeout(10_000, () => req.destroy(new Error("Local HTTP request timed out")));
        req.end(payload);
      });
      assert.ok(response.cookies.every((value) => !/;\s*domain=/i.test(value)));
      cookie = mergeSessionCookies(cookie, response.cookies);
      return response;
    },
  };
}

async function checkHttpRecovery() {
  const customerAuth = authRequests(origins.customer);
  const staffAuth = authRequests(origins.staff);
  const fixtureIds: string[] = [];
  try {
    stage = "local customer sign-in and authenticator setup";
    const customer = await createUser();
    fixtureIds.push(customer.id);
    const password = newPassword();
    const changedPassword = newPassword();
    await addCredential(customer.id, password);
    const signIn = (value: string) => customerAuth.request("/sign-in/email", { email: customer.email, password: value });
    assert.equal((await signIn(password)).status, 200);
    const setup = await customerAuth.request("/two-factor/enable", { method: "totp", password });
    assert.equal(setup.status, 200);
    assert.equal(setup.body?.method, "totp");
    assert.ok(setup.body?.totpURI && setup.body.backupCodes?.[0]);
    const backupCode = setup.body.backupCodes[0];
    const secret = new URL(setup.body.totpURI).searchParams.get("secret");
    assert.ok(secret);
    const authenticator = createOTP(base32.decode(secret), { period: 30, digits: 6 });
    const verifyTotp = async () => customerAuth.request("/two-factor/verify-totp", {
      code: await authenticator.totp(), trustDevice: false,
    });
    assert.equal((await verifyTotp()).status, 200);
    stage = "blocking Google callback session creation while customer TOTP is enabled";
    assert.equal(customerSessionCreationAllowed("/callback/google", true), false);
    assert.equal(customerSessionCreationAllowed("/sign-in/social", true), false);
    assert.equal((await customerAuth.request("/sign-out", {})).status, 200);

    stage = "password-only authentication cannot create a session with TOTP enabled";
    const challenge = await signIn(password);
    assert.equal(challenge.status, 200);
    assert.equal(challenge.body?.twoFactorRedirect, true);
    assert.equal(customerAuth.hasSessionCookie(), false);
    assert.equal((await customerAuth.request("/get-session")).body, null);
    assert.equal((await verifyTotp()).status, 200);
    assert.equal(customerAuth.hasSessionCookie(), true);
    assert.equal((await customerAuth.request("/get-session")).body?.user?.id, customer.id);

    stage = "customer password-change request";
    const changed = await customerAuth.request("/change-password", {
      currentPassword: password, newPassword: changedPassword, revokeOtherSessions: true,
    });
    assert.equal(changed.status, 200);
    stage = "customer session after password change";
    assert.equal((await customerAuth.request("/get-session")).body?.user?.id, customer.id);
    stage = "customer sign-out after password change";
    assert.equal((await customerAuth.request("/sign-out", {})).status, 200);
    stage = "customer password sign-in after password change";
    assert.equal((await signIn(changedPassword)).body?.twoFactorRedirect, true);
    stage = "customer backup-code request";
    const recovered = await customerAuth.request("/two-factor/verify-backup-code", { code: backupCode });
    assert.equal(recovered.status, 200);
    stage = "customer session after backup-code recovery";
    assert.equal((await customerAuth.request("/get-session")).body?.user?.twoFactorEnabled, true);
    stage = "customer TOTP disable request";
    assert.equal((await customerAuth.request("/two-factor/disable", { password: changedPassword })).status, 200);
    stage = "customer session after TOTP disable";
    assert.equal((await customerAuth.request("/get-session")).body?.user?.twoFactorEnabled, false);

    stage = "customer and staff reset token surface isolation";
    const staff = await createStaff("ADMIN", false, false);
    fixtureIds.push(staff.id);
    for (const [surface, user, right, wrong] of [
      ["customer", customer, customerAuth, staffAuth],
      ["staff", staff, staffAuth, customerAuth],
    ] as const) {
      const token = newPassword();
      const identifier = createHash("sha256").update(`gphkm:${surface}:reset-password:${token}`).digest("hex");
      await addVerification(identifier, user.id);
      const rejected = await wrong.request("/reset-password", { token, newPassword: newPassword() });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body?.code, "INVALID_TOKEN");
      // Verify the intended surface recognizes the token without committing an
      // irreversible audit row for a temporary account in the operator's DB.
      const recognized = await right.request("/reset-password", { token, newPassword: "too short" });
      assert.equal(recognized.status, 400);
      assert.equal(recognized.body?.code, "PASSWORD_TOO_SHORT");
    }
  } finally {
    if (fixtureIds.length > 0) {
      await db.query("DELETE FROM auth_verification WHERE value=any($1::text[])", [fixtureIds]);
      await db.query("DELETE FROM staff_account WHERE user_id=any($1::text[])", [fixtureIds]);
      await db.query("DELETE FROM auth_user WHERE id=any($1::text[])", [fixtureIds]);
    }
  }
}

try {
  await db.connect();
  const recovery = await checkDatabaseRecovery();
  await checkHttpRecovery();
  console.log(recovery.breakGlassSuccessSkipped
    ? "Auth recovery check passed. Verified TOTP-gated staff activation and promotion, factor reset/session revocation, current MFA-capable peer recovery guard, customer TOTP recovery, and reset token isolation. Successful break-glass recovery was skipped because an existing MFA-capable Super Admin must not be altered."
    : "Auth recovery check passed. Verified TOTP-gated staff activation and promotion, factor reset/session revocation, audited break-glass recovery, customer TOTP recovery, and reset token isolation.");
} catch (error: unknown) {
  // Driver errors can contain credentials. Keep only the safe stage and error
  // class; the detailed message stays out of the test output.
  const type = error instanceof Error ? error.name : "UnknownError";
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? ` SQLSTATE ${error.code}` : "";
  console.error(`Auth recovery check failed during ${stage} (${type}${code}). Verify against the disposable local database and running app.`);
  process.exitCode = 1;
} finally {
  await db.end().catch(() => { process.exitCode = 1; });
}
