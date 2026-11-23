import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { Client } from "pg";
import { mergeSessionCookies } from "../src/server/auth/session-cookies.ts";

const customerOrigin = "https://customer.gphkm-auth.test";
const staffOrigin = "https://staff.gphkm-auth.test";
const termsVersion = "auth-smoke-terms-v1";
const privacyVersion = "auth-smoke-privacy-v1";
const email = `customer-auth-${randomBytes(10).toString("hex")}@gphkm.test`;
const staffEmail = `staff-reset-${randomBytes(10).toString("hex")}@gphkm.test`;
const makePassword = () => randomBytes(24).toString("base64url");

type AuthBody = { code?: string; status?: boolean; url?: string; session?: { id: string }; user?: { id: string } } | null;
type Mail = { type: "auth-email-fixture"; to: string; subject: string; text: string };

function fixtureUrl(key: string, role: string): URL {
  const value = process.env[key];
  if (!value) throw new Error("Test database configuration is incomplete");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1"
    || !url.port || (url.port === "54329" && url.pathname === "/gphkm")
    || !["/gphkm", "/gphkm_auth_email_check"].includes(url.pathname)
    || url.username !== role || !url.password) {
    throw new Error("This check requires a separate loopback GPHKM database and the expected roles");
  }
  return url;
}

async function reservePort() {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function browser(port: number, origin: string) {
  let cookie = "";
  return {
    hasSession: () => /(?:^|;\s*)[^=;]*\.session_token=[^;]+/.test(cookie),
    async send(path: string, body?: object) {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const response = await new Promise<{
        status: number; body: AuthBody; cookies: string[]; referrerPolicy?: string; redirect?: string;
      }>((resolve, reject) => {
        const req = request({
          hostname: "127.0.0.1", port, path,
          method: payload === undefined ? "GET" : "POST",
          headers: {
            Host: new URL(origin).host, Origin: origin, "X-Forwarded-Proto": "https", "X-Forwarded-For": "127.0.0.1",
            ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
            ...(cookie ? { Cookie: cookie } : {}),
          },
        }, (res) => {
          let content = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { content += chunk; });
          res.on("error", reject);
          res.on("end", () => {
            let body: AuthBody = null;
            try { body = JSON.parse(content) as AuthBody; } catch { /* Verification redirect and reset page are not JSON. */ }
            resolve({
              status: res.statusCode ?? 0, body, cookies: res.headers["set-cookie"] ?? [],
              referrerPolicy: res.headers["referrer-policy"] as string | undefined,
              redirect: res.headers.location,
            });
          });
        });
        req.on("error", reject);
        req.setTimeout(10_000, () => req.destroy(new Error("Local request timed out")));
        req.end(payload);
      });

      assert.ok(response.cookies.every((header) => !/;\s*domain=/i.test(header)));
      for (const header of response.cookies.filter((cookie) => /^[^=;]*\.session_token=.+/i.test(cookie))) {
        assert.ok(/;\s*secure(?:;|$)/i.test(header) && /;\s*httponly(?:;|$)/i.test(header) && /;\s*samesite=lax(?:;|$)/i.test(header));
      }
      cookie = mergeSessionCookies(cookie, response.cookies);
      return response;
    },
  };
}

function mailUrl(mail: Mail) {
  const link = mail.text.split("\n").find((line) => line.startsWith("https://"));
  assert.ok(link);
  return new URL(link);
}

function verificationEndpoint(link: URL) {
  const endpoint = new URL("/api/auth/verify-email", link.origin);
  const token = link.searchParams.get("token");
  assert.ok(token);
  endpoint.searchParams.set("token", token);
  const callbackURL = link.searchParams.get("callbackURL");
  if (callbackURL) endpoint.searchParams.set("callbackURL", callbackURL);
  return endpoint;
}

async function waitForMail(outbox: Mail[], subject: string, recipient = email) {
  for (let i = 0; i < 50; i++) {
    const message = outbox.find((mail) => mail.to === recipient && mail.subject === subject);
    if (message) return message;
    await delay(100);
  }
  throw new Error("Expected synthetic auth mail");
}

async function waitForMailCount(outbox: Mail[], subject: string, count: number, recipient = email) {
  for (let i = 0; i < 50; i++) {
    const messages = outbox.filter((mail) => mail.to === recipient && mail.subject === subject);
    if (messages.length >= count) return messages[messages.length - 1]!;
    await delay(100);
  }
  throw new Error("Expected additional synthetic auth mail");
}

let stage = "disposable database configuration";
let db: Client | undefined;
let child: ReturnType<typeof fork> | undefined;
let stopped: Promise<unknown> | undefined;
try {
  assert.equal(process.env.GPHKM_AUTH_EMAIL_CHECK_ISOLATED_DB, "true");
  const migrationUrl = fixtureUrl("MIGRATION_DATABASE_URL", "gphkm_migration");
  const runtimeUrl = fixtureUrl("DATABASE_URL", "gphkm_runtime");
  const proofUrl = fixtureUrl("MFA_PROOF_DATABASE_URL", "gphkm_mfa_proof");
  assert.ok(migrationUrl.port === runtimeUrl.port && proofUrl.port === runtimeUrl.port);
  assert.ok(migrationUrl.pathname === runtimeUrl.pathname && proofUrl.pathname === runtimeUrl.pathname);
  db = new Client({ connectionString: migrationUrl.toString() });
  await db.connect();
  // Signup records immutable legal acceptance and reset evidence. Running on
  // an empty database keeps every committed fixture tied to the disposable DB.
  assert.equal((await db.query("SELECT 1 FROM auth_user LIMIT 1")).rowCount, 0);

  stage = "starting the production build on loopback";
  const port = await reservePort();
  const outbox: Mail[] = [];
  let childFailed = false;
  child = fork(fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url)), ["start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    execArgv: ["--import", new URL("./fixtures/capture-auth-email.mjs", import.meta.url).href],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: runtimeUrl.toString(),
      MFA_PROOF_DATABASE_URL: proofUrl.toString(),
      CUSTOMER_APP_URL: customerOrigin, STAFF_APP_URL: staffOrigin,
      GPHKM_PUBLIC_BASE_URL: "https://hooks.gphkm-auth.test",
      GPHKM_TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
      GPHKM_LOCAL_AUTH_ENABLED: "false",
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      GOOGLE_CLIENT_ID: "synthetic-test.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "synthetic-test-only",
      GPHKM_TERMS_VERSION: termsVersion, GPHKM_PRIVACY_VERSION: privacyVersion,
      GPHKM_TERMS_URL: `${customerOrigin}/legal/terms`, GPHKM_PRIVACY_URL: `${customerOrigin}/legal/privacy`,
      RESEND_API_KEY: "re_local_auth_fixture", RESEND_SYSTEM_FROM_EMAIL: "no-reply@gphkm.test",
      RESEND_SUPPORT_FROM_EMAIL: "support@gphkm.test",
      GPHKM_RESEND_DATA_HANDLING_APPROVED: "true", GPHKM_AUTH_EMAIL_CHECK_CHILD: "true",
    },
  });
  child.on("message", (message: Mail) => {
    if (message.type === "auth-email-fixture") outbox.push(message);
  });
  stopped = new Promise<void>((resolve) => {
    child?.once("exit", () => { childFailed = true; resolve(); });
    child?.once("error", () => { childFailed = true; resolve(); });
  });

  const customer = browser(port, customerOrigin);
  const staff = browser(port, staffOrigin);
  let ready = false;
  for (let i = 0; i < 60 && !childFailed; i++) {
    ready = (await customer.send("/api/health").catch(() => null))?.status === 200;
    if (ready) break;
    await delay(150);
  }
  assert.ok(ready && !childFailed);

  stage = "declined and stale legal consent rejected before signup";
  const password = makePassword();
  const signup = { name: "Synthetic auth check", email, password, callbackURL: "/customer" };
  const missing = await customer.send("/api/auth/sign-up/email", signup);
  assert.equal(missing.status, 400);
  assert.equal(missing.body?.code, "LEGAL_ACCEPTANCE_REQUIRED");
  const stale = await customer.send("/api/auth/sign-up/email", {
    ...signup, legalConsent: { accepted: true, termsVersion, privacyVersion: "expired" },
  });
  assert.equal(stale.status, 400);
  assert.equal(stale.body?.code, "LEGAL_ACCEPTANCE_REQUIRED");
  assert.equal((await db.query("SELECT 1 FROM auth_user WHERE email=$1", [email])).rowCount, 0);

  stage = "customer signup and immutable legal acceptance";
  const registered = await customer.send("/api/auth/sign-up/email", {
    ...signup, legalConsent: { accepted: true, termsVersion, privacyVersion },
  });
  assert.equal(registered.status, 200);
  assert.equal(customer.hasSession(), false);
  const signupEvidence = await db.query<{ id: string; email_verified: boolean }>(
    `SELECT u.id,u.email_verified FROM auth_user u
     JOIN customer_legal_acceptance l ON l.user_id=u.id AND l.actor_user_id=u.id
     WHERE u.email=$1 AND l.terms_version=$2 AND l.privacy_version=$3
       AND l.terms_url=$4 AND l.privacy_url=$5`,
    [email, termsVersion, privacyVersion, `${customerOrigin}/legal/terms`, `${customerOrigin}/legal/privacy`],
  );
  assert.equal(signupEvidence.rowCount, 1);
  const { id: userId, email_verified: emailVerified } = signupEvidence.rows[0]!;
  assert.equal(emailVerified, false);

  stage = "verification mail and unverified sign-in denial";
  const verificationLink = mailUrl(await waitForMail(outbox, "Verify your GPHKM email"));
  stage = "verification confirmation link origin";
  assert.equal(verificationLink.origin, customerOrigin);
  stage = `verification confirmation path ${verificationLink.pathname}`;
  assert.equal(verificationLink.pathname, "/sign-in/confirm-email");
  const linkToken = verificationLink.searchParams.get("token");
  stage = `verification token query state ${verificationLink.searchParams.has("token") ? "present" : "missing"}/${Boolean(linkToken) ? "nonempty" : "empty"}`;
  assert.ok(linkToken);
  stage = "unverified sign-in denial";
  stage = "unverified sign-in request";
  const unverified = await customer.send("/api/auth/sign-in/email", { email, password });
  stage = "unverified sign-in status";
  assert.equal(unverified.status, 403);
  const signInErrorCode = unverified.body?.code;
  stage = signInErrorCode === "EMAIL_NOT_VERIFIED" ? "unverified sign-in expected error code"
    : signInErrorCode === undefined ? "unverified sign-in missing error code"
      : /^[A-Z0-9_]{1,64}$/.test(signInErrorCode) ? `unverified sign-in error code ${signInErrorCode}`
        : "unverified sign-in unexpected error code format";
  assert.equal(signInErrorCode, "EMAIL_NOT_VERIFIED");
  stage = customer.hasSession() ? "unverified sign-in created a session" : "unverified sign-in created no session";
  assert.equal(customer.hasSession(), false);
  stage = "verification confirmation route remains correct";
  assert.equal(verificationLink.pathname, "/sign-in/confirm-email");
  stage = "verification token remains present";
  assert.ok(verificationLink.searchParams.get("token"));
  const verificationUrl = verificationEndpoint(verificationLink);
  const verificationToken = verificationLink.searchParams.get("token");
  stage = "verification token parses";
  assert.ok(verificationToken);
  const verificationIdentifier = `gphkm:email-verification:customer:${createHash("sha256").update(verificationToken).digest("hex")}`;
  const tokenExpiresAt = (JSON.parse(Buffer.from(verificationToken.split(".")[1]!, "base64url").toString("utf8")) as { exp: number }).exp;
  const verificationMarker = await db.query<{ value: string; expires_at: Date }>(
    "SELECT value,expires_at FROM auth_verification WHERE identifier=$1", [verificationIdentifier],
  );
  stage = "verification one-time marker exists";
  assert.equal(verificationMarker.rowCount, 1);
  stage = "verification marker is bound to user";
  assert.equal(verificationMarker.rows[0]?.value, userId);
  stage = "verification marker expiry matches signed token";
  assert.equal(Math.floor(verificationMarker.rows[0]!.expires_at.getTime() / 1000), tokenExpiresAt);
  stage = "verification token is not stored as plaintext";
  assert.equal((await db.query("SELECT 1 FROM auth_verification WHERE value=$1 OR identifier=$1", [verificationToken])).rowCount, 0);
  stage = "verification marker can be expired for negative test";
  await db.query("UPDATE auth_verification SET expires_at=now()-interval '1 second' WHERE identifier=$1", [verificationIdentifier]);
  const expiredVerification = await browser(port, customerOrigin).send(verificationUrl.pathname + verificationUrl.search);
  assert.equal(expiredVerification.status, 400);
  assert.equal(expiredVerification.body?.code, "INVALID_TOKEN");
  assert.equal(expiredVerification.body?.user, undefined);
  assert.equal((await db.query("SELECT 1 FROM auth_user WHERE id=$1 AND NOT email_verified", [userId])).rowCount, 1);

  stage = "fresh verification request";
  const resendVerification = await customer.send("/api/auth/send-verification-email", { email, callbackURL: "/sign-in" });
  stage = "fresh verification request accepted";
  assert.equal(resendVerification.status, 200);
  const freshVerificationLink = mailUrl(await waitForMailCount(outbox, "Verify your GPHKM email", 2));
  stage = "fresh verification origin";
  assert.equal(freshVerificationLink.origin, customerOrigin);
  stage = "fresh verification confirmation path";
  assert.equal(freshVerificationLink.pathname, "/sign-in/confirm-email");
  const freshVerificationUrl = verificationEndpoint(freshVerificationLink);
  const freshVerificationToken = freshVerificationLink.searchParams.get("token");
  stage = "fresh verification token present";
  assert.ok(freshVerificationToken);
  const freshVerificationIdentifier = `gphkm:email-verification:customer:${createHash("sha256").update(freshVerificationToken).digest("hex")}`;
  stage = "fresh verification marker persisted";
  assert.equal((await db.query("SELECT 1 FROM auth_verification WHERE identifier=$1 AND value=$2 AND expires_at>now()", [freshVerificationIdentifier, userId])).rowCount, 1);
  const confirmationPage = await browser(port, customerOrigin).send(freshVerificationLink.pathname + freshVerificationLink.search);
  stage = "confirmation landing page displays";
  assert.equal(confirmationPage.status, 200);
  stage = "passive landing page leaves token unused";
  assert.equal((await db.query("SELECT 1 FROM auth_verification WHERE identifier=$1", [freshVerificationIdentifier])).rowCount, 1);
  const wrongSurfaceVerification = await browser(port, staffOrigin).send(freshVerificationUrl.pathname + freshVerificationUrl.search);
  stage = "wrong surface is rejected";
  assert.equal(wrongSurfaceVerification.status, 400);
  stage = "wrong surface reports invalid token";
  assert.equal(wrongSurfaceVerification.body?.code, "INVALID_TOKEN");
  stage = "wrong surface does not consume customer token";
  assert.equal((await db.query("SELECT 1 FROM auth_verification WHERE identifier=$1", [freshVerificationIdentifier])).rowCount, 1);

  const verificationBrowsers = [browser(port, customerOrigin), browser(port, customerOrigin)];
  stage = "concurrent verification requests";
  const concurrentVerification = await Promise.all(verificationBrowsers.map((tab) => tab.send(freshVerificationUrl.pathname + freshVerificationUrl.search)));
  stage = "exactly one concurrent verification succeeds";
  assert.deepEqual(concurrentVerification.map((response) => response.status).sort(), [302, 400]);
  const winnerIndex = concurrentVerification.findIndex((response) => response.status >= 300 && response.status < 400);
  stage = "successful verification response redirects";
  assert.ok(winnerIndex >= 0 && concurrentVerification[winnerIndex]?.redirect);
  stage = "verification redirect stays on customer origin";
  assert.equal(new URL(concurrentVerification[winnerIndex]!.redirect!, customerOrigin).origin, customerOrigin);
  stage = "only successful verifier receives a session";
  assert.equal((await verificationBrowsers[winnerIndex]!.send("/api/auth/get-session")).body?.user?.id, userId);
  stage = "losing verifier receives no session";
  assert.equal((await verificationBrowsers[1 - winnerIndex]!.send("/api/auth/get-session")).body, null);
  const verificationReplay = await browser(port, customerOrigin).send(freshVerificationUrl.pathname + freshVerificationUrl.search);
  stage = "verification replay is rejected";
  assert.equal(verificationReplay.status, 400);
  stage = "verification replay reports invalid token";
  assert.equal(verificationReplay.body?.code, "INVALID_TOKEN");
  stage = "verification marker consumed";
  assert.equal((await db.query("SELECT 1 FROM auth_verification WHERE identifier=$1", [freshVerificationIdentifier])).rowCount, 0);
  stage = "verification marks the user as verified";
  assert.equal((await db.query("SELECT 1 FROM auth_user WHERE id=$1 AND email_verified", [userId])).rowCount, 1);
  await delay(100);
  stage = "exactly one welcome email is sent";
  assert.equal(outbox.filter((mail) => mail.to === email && mail.subject === "Welcome to GPHKM").length, 1);

  stage = "separate active credential session before reset";
  const secondSession = browser(port, customerOrigin);
  assert.equal((await secondSession.send("/api/auth/sign-in/email", { email, password })).status, 200);
  assert.equal((await secondSession.send("/api/auth/get-session")).body?.user?.id, userId);

  stage = "generic reset response and fragment-only email";
  const signedOut = browser(port, customerOrigin);
  const resetRequest = await signedOut.send("/api/auth/request-password-reset", { email });
  const unknownRequest = await signedOut.send("/api/auth/request-password-reset", { email: `unknown-${email}` });
  assert.equal(resetRequest.status, 200);
  assert.equal(unknownRequest.status, 200);
  assert.deepEqual(resetRequest.body, unknownRequest.body);
  const resetLink = mailUrl(await waitForMail(outbox, "Reset your GPHKM password"));
  assert.equal(resetLink.origin, customerOrigin);
  assert.equal(resetLink.pathname, "/sign-in/reset-password");
  assert.equal(resetLink.search, "");
  const fragment = new URLSearchParams(resetLink.hash.slice(1));
  const token = fragment.get("token");
  assert.ok(token && /^[A-Za-z0-9_-]{16,128}$/.test(token) && fragment.size === 1);
  const resetPage = await signedOut.send(resetLink.pathname);
  assert.equal(resetPage.status, 200);
  assert.equal(resetPage.referrerPolicy, "no-referrer");

  stage = "wrong-surface rejection, concurrent one-time reset, and replay rejection";
  const changedPasswords = [makePassword(), makePassword()];
  const wrongSurface = await staff.send("/api/auth/reset-password", { token, newPassword: changedPasswords[0] });
  assert.equal(wrongSurface.status, 400);
  assert.equal(wrongSurface.body?.code, "INVALID_TOKEN");
  const resetBrowsers = [browser(port, customerOrigin), browser(port, customerOrigin)];
  const concurrentReset = await Promise.all(resetBrowsers.map((tab, index) => tab.send("/api/auth/reset-password", { token, newPassword: changedPasswords[index] })));
  assert.deepEqual(concurrentReset.map((response) => response.status).sort(), [200, 400]);
  const resetWinnerIndex = concurrentReset.findIndex((response) => response.status === 200);
  const changedPassword = changedPasswords[resetWinnerIndex]!;
  const replay = await signedOut.send("/api/auth/reset-password", { token, newPassword: makePassword() });
  assert.equal(replay.status, 400);
  assert.equal(replay.body?.code, "INVALID_TOKEN");
  const identifier = createHash("sha256").update(`gphkm:customer:reset-password:${token}`).digest("hex");
  assert.equal((await db.query("SELECT 1 FROM auth_verification WHERE identifier=$1", [identifier])).rowCount, 0);

  stage = "old sessions revoked and new password accepted";
  assert.equal((await customer.send("/api/auth/get-session")).body, null);
  assert.equal((await secondSession.send("/api/auth/get-session")).body, null);
  assert.equal((await db.query("SELECT 1 FROM auth_session WHERE user_id=$1", [userId])).rowCount, 0);
  const credential = await db.query<{ password: string }>(
    "SELECT password FROM auth_account WHERE user_id=$1 AND provider_id='credential'", [userId],
  );
  const hash = credential.rows[0]?.password;
  assert.ok(hash && !await verifyPassword({ hash, password }) && await verifyPassword({ hash, password: changedPassword }));
  assert.equal((await signedOut.send("/api/auth/sign-in/email", { email, password: changedPassword })).status, 200);
  assert.equal((await signedOut.send("/api/auth/get-session")).body?.user?.id, userId);
  const audit = await db.query(
    "SELECT 1 FROM audit_event WHERE actor_user_id=$1 AND target_id=$1 AND action='auth.password_reset_completed'", [userId],
  );
  assert.equal(audit.rowCount, 1);

  stage = "staff password reset routing, link scope, and session revocation";
  const staffUserId = randomUUID();
  const staffPassword = makePassword();
  await db.query(
    "INSERT INTO auth_user(id,name,email,email_verified,two_factor_enabled) VALUES($1,'Synthetic staff reset check',$2,true,false)",
    [staffUserId, staffEmail],
  );
  await db.query("INSERT INTO staff_account(user_id,role,active) VALUES($1,'ADMIN',false)", [staffUserId]);
  await db.query(
    "INSERT INTO auth_account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
    [randomUUID(), staffUserId, await hashPassword(staffPassword)],
  );

  const customerSurfaceReset = await browser(port, customerOrigin).send("/api/auth/request-password-reset", { email: staffEmail });
  assert.equal(customerSurfaceReset.status, 200);
  assert.equal(outbox.some((mail) => mail.to === staffEmail), false);

  const staffSession = browser(port, staffOrigin);
  assert.equal((await staffSession.send("/api/auth/sign-in/email", { email: staffEmail, password: staffPassword })).status, 200);
  assert.equal(staffSession.hasSession(), true);
  assert.equal((await staffSession.send("/api/auth/get-session")).body?.user?.id, staffUserId);
  const staffResetRequest = await staffSession.send("/api/auth/request-password-reset", { email: staffEmail });
  assert.equal(staffResetRequest.status, 200);
  const staffResetLink = mailUrl(await waitForMail(outbox, "Reset your GPHKM staff password", staffEmail));
  assert.equal(staffResetLink.origin, staffOrigin);
  assert.equal(staffResetLink.pathname, "/staff/sign-in/reset-password");
  assert.equal(staffResetLink.search, "");
  const staffFragment = new URLSearchParams(staffResetLink.hash.slice(1));
  const staffToken = staffFragment.get("token");
  assert.ok(staffToken && /^[A-Za-z0-9_-]{16,128}$/.test(staffToken) && staffFragment.size === 1);

  const customerHostRejectsStaffReset = await browser(port, customerOrigin).send("/api/auth/reset-password", {
    token: staffToken, newPassword: makePassword(),
  });
  assert.equal(customerHostRejectsStaffReset.status, 400);
  assert.equal(customerHostRejectsStaffReset.body?.code, "INVALID_TOKEN");
  const changedStaffPassword = makePassword();
  assert.equal((await staffSession.send("/api/auth/reset-password", { token: staffToken, newPassword: changedStaffPassword })).status, 200);
  assert.equal((await staffSession.send("/api/auth/reset-password", { token: staffToken, newPassword: makePassword() })).body?.code, "INVALID_TOKEN");
  assert.equal((await staffSession.send("/api/auth/get-session")).body, null);
  assert.equal((await db.query("SELECT 1 FROM auth_session WHERE user_id=$1", [staffUserId])).rowCount, 0);
  const staffCredential = await db.query<{ password: string }>(
    "SELECT password FROM auth_account WHERE user_id=$1 AND provider_id='credential'", [staffUserId],
  );
  assert.ok(staffCredential.rows[0]?.password
    && !await verifyPassword({ hash: staffCredential.rows[0].password, password: staffPassword })
    && await verifyPassword({ hash: staffCredential.rows[0].password, password: changedStaffPassword }));
  assert.equal((await staffSession.send("/api/auth/sign-in/email", { email: staffEmail, password: changedStaffPassword })).status, 200);
  assert.equal((await db.query(
    "SELECT 1 FROM audit_event WHERE actor_user_id=$1 AND target_id=$1 AND action='auth.password_reset_completed' AND metadata->>'result'='staff'",
    [staffUserId],
  )).rowCount, 1);

  stage = "customer Google OAuth initiation and staff provider denial";
  const google = await browser(port, customerOrigin).send("/api/auth/sign-in/social", {
    provider: "google", callbackURL: "/customer", disableRedirect: true,
  });
  assert.equal(google.status, 200);
  assert.ok(google.body?.url);
  const googleRedirect = new URL(google.body.url);
  assert.equal(googleRedirect.origin, "https://accounts.google.com");
  assert.equal(googleRedirect.searchParams.get("redirect_uri"), `${customerOrigin}/api/auth/callback/google`);
  assert.ok(googleRedirect.searchParams.get("state"));
  const deniedGoogle = await staff.send("/api/auth/sign-in/social", {
    provider: "google", callbackURL: "/staff", disableRedirect: true,
  });
  assert.equal(deniedGoogle.status, 404);
  assert.equal(deniedGoogle.body?.code, "PROVIDER_NOT_FOUND");

  console.log("Customer and staff auth passed in production mode with captured mail: legal consent, one-time surface-bound email verification, concurrent single-use resets, session revocation, and Google redirect initiation.");
} catch {
  // Never print response objects, mail payloads, assertion details, or driver errors.
  console.error(`Customer email auth check failed during ${stage}.`);
  process.exitCode = 1;
} finally {
  child?.kill();
  await stopped;
  await db?.end().catch(() => { process.exitCode = 1; });
}
