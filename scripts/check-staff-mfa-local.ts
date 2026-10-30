import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { Client } from "pg";
import { assertLoopbackUrl, localAuthEnabled, requiredEnv } from "../src/server/auth/policy.ts";

if (process.env.NODE_ENV !== "development" || !localAuthEnabled(process.env)) {
  throw new Error("This check requires local development authentication");
}

const staffOrigin = assertLoopbackUrl(requiredEnv(process.env, "STAFF_APP_URL"), "STAFF_APP_URL").origin;
const customerOrigin = assertLoopbackUrl(requiredEnv(process.env, "CUSTOMER_APP_URL"), "CUSTOMER_APP_URL").origin;
const migrationUrl = assertLoopbackUrl(requiredEnv(process.env, "MIGRATION_DATABASE_URL"), "MIGRATION_DATABASE_URL");
if (!staffOrigin.startsWith("http") || !customerOrigin.startsWith("http") || !["postgres:", "postgresql:"].includes(migrationUrl.protocol)) {
  throw new Error("Invalid local staff MFA check configuration");
}

const db = new Client({ connectionString: migrationUrl.toString() });
const userId = randomUUID();
const email = `staff-mfa-check-${userId}@gphkm.test`;
const password = `${randomUUID()}Aa1!`;
const cookies = new Map<string, string>();
let userCreated = false;

function absorbCookies(response: Response) {
  for (const value of response.headers.getSetCookie()) {
    const [pair, ...attributes] = value.split(";");
    const equalsAt = pair.indexOf("=");
    if (equalsAt < 1) continue;
    const name = pair.slice(0, equalsAt).trim();
    const cookieValue = pair.slice(equalsAt + 1);
    if (/max-age=0/i.test(attributes.join(";")) || !cookieValue) cookies.delete(name);
    else cookies.set(name, cookieValue);
  }
}

function cookieHeader() {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function request(origin: string, path: string, body?: unknown) {
  const cookie = cookieHeader();
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
  });
  absorbCookies(response);
  return response;
}

function assertRedirectTo(response: Response, origin: string, pathname: string) {
  const location = response.headers.get("location");
  if (response.status !== 307 || !location || new URL(location, origin).pathname !== pathname) {
    throw new Error(`Expected a redirect to ${pathname}; received HTTP ${response.status}`);
  }
}

try {
  await db.connect();
  await db.query("INSERT INTO auth_user(id,name,email,email_verified) VALUES ($1,$2,$3,true)", [userId, "Temporary MFA check", email]);
  userCreated = true;
  await db.query(
    "INSERT INTO auth_account(id,account_id,provider_id,user_id,password) VALUES ($1,$2,'credential',$2,$3)",
    [randomUUID(), userId, await hashPassword(password)],
  );
  await db.query("INSERT INTO staff_account(user_id,role) VALUES ($1,'ADMIN')", [userId]);

  let response = await request(staffOrigin, "/api/auth/sign-in/email", { email, password, callbackURL: "/staff" });
  if (!response.ok) throw new Error(`Temporary staff sign-in returned HTTP ${response.status}`);
  response = await request(staffOrigin, "/staff");
  assertRedirectTo(response, staffOrigin, "/staff/sign-in");

  response = await request(staffOrigin, "/api/auth/two-factor/enable", { method: "totp", password, issuer: "GPHKM Staff" });
  if (!response.ok) throw new Error(`Temporary staff MFA setup returned HTTP ${response.status}`);
  const setup = await response.json() as { method?: unknown; totpURI?: unknown };
  if (setup.method !== "totp" || typeof setup.totpURI !== "string") throw new Error("Temporary staff MFA setup response was incomplete");
  const secret = new URL(setup.totpURI).searchParams.get("secret");
  if (!secret) throw new Error("Temporary staff MFA setup secret was missing");

  const code = await createOTP(base32.decode(secret), { period: 30, digits: 6 }).totp();
  response = await request(staffOrigin, "/api/auth/two-factor/verify-totp", { code, trustDevice: false });
  const verification = await response.json() as { token?: unknown; code?: unknown };
  if (!response.ok || typeof verification.token !== "string") throw new Error(`Temporary staff MFA verification failed with HTTP ${response.status}`);

  response = await request(staffOrigin, "/api/auth/get-session");
  const session = await response.json() as { session?: { id?: unknown }; user?: { twoFactorEnabled?: unknown } };
  if (typeof session.session?.id !== "string" || session.user?.twoFactorEnabled !== true) throw new Error("Verified staff session was unavailable");
  const proof = await db.query("SELECT 1 FROM staff_mfa_session WHERE session_id=$1 AND user_id=$2", [session.session.id, userId]);
  if (proof.rowCount !== 1) throw new Error("Verified staff MFA proof was not persisted");

  response = await request(staffOrigin, "/staff");
  if (response.status !== 200) throw new Error(`Verified staff session could not open the staff console (HTTP ${response.status})`);

  response = await request(customerOrigin, "/sign-in");
  const customerSignIn = await response.text();
  if (response.status !== 200 || customerSignIn.includes(email)) throw new Error("Staff identity leaked into the customer sign-in projection");
  response = await request(customerOrigin, "/customer/settings");
  const customerWorkspace = await response.text();
  if (response.status !== 200 || customerWorkspace.includes(email) || !customerWorkspace.includes("Sign in or create an account")) {
    throw new Error("Forwarded staff session crossed into customer workspace identity");
  }

  await db.query("DELETE FROM staff_mfa_session WHERE session_id=$1", [session.session.id]);
  response = await request(staffOrigin, "/staff");
  assertRedirectTo(response, staffOrigin, "/staff/sign-in");
  console.log("Local staff MFA check passed: password-only staff access is denied, verified TOTP grants the staff console, missing MFA proof revokes that access, and a forwarded staff cookie is rejected by customer surfaces.");
} catch (error) {
  console.error(`Local staff MFA check failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  if (userCreated) {
    await db.query("DELETE FROM staff_account WHERE user_id=$1", [userId]).catch(() => {});
    await db.query("DELETE FROM auth_user WHERE id=$1", [userId]).catch(() => {});
  }
  await db.end().catch(() => {});
}
