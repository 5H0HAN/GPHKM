import { Client } from "pg";
import { assertLoopbackUrl, localAuthEnabled, requiredEnv } from "../src/server/auth/policy.ts";

if (process.env.NODE_ENV !== "development" || !localAuthEnabled(process.env)) {
  throw new Error("This check requires local development authentication");
}

const customerOrigin = assertLoopbackUrl(requiredEnv(process.env, "CUSTOMER_APP_URL"), "CUSTOMER_APP_URL").origin;
const staffOrigin = assertLoopbackUrl(requiredEnv(process.env, "STAFF_APP_URL"), "STAFF_APP_URL").origin;
const databaseUrl = assertLoopbackUrl(requiredEnv(process.env, "MIGRATION_DATABASE_URL"), "MIGRATION_DATABASE_URL");
if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
  throw new Error("MIGRATION_DATABASE_URL must use PostgreSQL");
}

const email = requiredEnv(process.env, "BOOTSTRAP_CUSTOMER_EMAIL");
const password = requiredEnv(process.env, "BOOTSTRAP_CUSTOMER_PASSWORD");
const db = new Client({ connectionString: databaseUrl.toString() });
let sessionId: string | undefined;
let userId: string | undefined;
let dbConnected = false;
let stage = "customer fixture sign-in";

try {
  stage = "local database connection";
  await db.connect();
  dbConnected = true;

  stage = "customer fixture sign-in";
  const signIn = await fetch(`${customerOrigin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: customerOrigin },
    body: JSON.stringify({ email, password, callbackURL: "/customer" }),
    redirect: "manual",
  });
  if (!signIn.ok) {
    stage = `customer fixture sign-in returned HTTP ${signIn.status}`;
    throw new Error("Local customer fixture sign-in failed");
  }

  stage = "session cookie capture";
  const cookieHeaders = signIn.headers.getSetCookie?.() ?? [signIn.headers.get("set-cookie") ?? ""];
  const cookie = cookieHeaders.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
  if (!cookie) throw new Error("Local customer sign-in did not issue a session cookie");

  stage = "session metadata read";
  const sessionResponse = await fetch(`${customerOrigin}/api/auth/get-session`, { headers: { cookie } });
  if (!sessionResponse.ok) throw new Error(`Session metadata returned HTTP ${sessionResponse.status}`);
  const sessionResult = await sessionResponse.json() as {
    session?: { id?: unknown; createdAt?: unknown; userId?: unknown };
    user?: { id?: unknown };
  } | null;
  if (!sessionResult?.session || typeof sessionResult.session.id !== "string" || typeof sessionResult.user?.id !== "string") {
    throw new Error("Local customer session response was incomplete");
  }
  sessionId = sessionResult.session.id;
  userId = sessionResult.user.id;

  stage = "customer sign-in redirect to the workspace";
  const customerSignInPage = await fetch(`${customerOrigin}/sign-in`, { headers: { cookie } });
  if (customerSignInPage.status !== 200 || new URL(customerSignInPage.url).pathname !== "/customer") {
    throw new Error("An authenticated customer did not reach the customer workspace from sign-in");
  }

  stage = "customer identity isolation on staff sign-in";
  const staffSignInPage = await fetch(`${staffOrigin}/staff/sign-in`, { headers: { cookie } });
  const staffSignInHtml = await staffSignInPage.text();
  if (staffSignInPage.status !== 200 || staffSignInHtml.includes(email.trim().toLowerCase()) || !staffSignInHtml.includes("STAFF WORKSPACE")) {
    throw new Error("Staff sign-in did not remain distinct or exposed the customer identity");
  }

  stage = "temporary session aging";
  const aged = await db.query(
    "UPDATE auth_session SET created_at = now() - interval '11 minutes' WHERE id = $1 AND user_id = $2",
    [sessionId, userId],
  );
  if (aged.rowCount !== 1) throw new Error("Could not age the temporary local customer session");

  stage = "customer workspace access";
  const customerRoutes = [
    "/customer",
    "/customer/catalog",
    "/customer/orders",
    "/customer/wallet",
    "/customer/settings",
    "/customer/settings/organization",
    "/customer/support",
    "/customer/notifications",
  ];
  for (const path of customerRoutes) {
    const response = await fetch(`${customerOrigin}${path}`, { headers: { cookie }, redirect: "manual" });
    if (response.status !== 200) {
      stage = `${path} returned HTTP ${response.status}`;
      throw new Error("Local customer fixture could not access an authorized customer route");
    }
    await response.arrayBuffer();
  }

  stage = "customer-to-staff authorization boundary";
  const staffWorkspace = await fetch(`${staffOrigin}/staff`, { headers: { cookie }, redirect: "manual" });
  if (staffWorkspace.status !== 307 || new URL(staffWorkspace.headers.get("location") ?? "/", staffOrigin).pathname !== "/staff/sign-in") {
    stage = `customer session was not denied staff workspace (HTTP ${staffWorkspace.status})`;
    throw new Error("Customer session crossed into staff workspace");
  }

  stage = "customer-to-staff API authorization boundary";
  const staffCommand = await fetch(`${staffOrigin}/api/staff/catalog/import`, {
    method: "POST",
    headers: { cookie, origin: staffOrigin, "content-type": "multipart/form-data; boundary=local-probe" },
    redirect: "manual",
  });
  const staffCommandLocation = new URL(staffCommand.headers.get("location") ?? "/", staffOrigin);
  if (staffCommand.status !== 303 || staffCommandLocation.pathname !== "/staff/suppliers/imports" || staffCommandLocation.searchParams.get("error") !== "stage") {
    stage = `customer session was not denied staff API command (HTTP ${staffCommand.status})`;
    throw new Error("Customer session crossed into staff API");
  }

  stage = "direct revocation endpoint check";
  const routes = [
    { path: "/revoke-session", body: { token: "local-session-guard-probe-nonexistent" } },
    { path: "/revoke-other-sessions", body: {} },
    { path: "/revoke-sessions", body: {} },
  ];
  for (const route of routes) {
    const response = await fetch(`${customerOrigin}/api/auth${route.path}`, {
      method: "POST",
      headers: { cookie, origin: customerOrigin, "content-type": "application/json" },
      body: JSON.stringify(route.body),
      redirect: "manual",
    });
    if (response.status !== 403) {
      stage = `${route.path} returned HTTP ${response.status}`;
      throw new Error(`Expected stale-session denial for ${route.path}; received HTTP ${response.status}`);
    }
  }
  console.log("Local identity security check passed: sign-in session projections are host-bound, customer catalog/orders/wallet/settings/support/notifications routes are allowed, staff page/API are denied, and all direct revocation endpoints deny the stale session.");
} catch {
  console.error(`Local customer session revocation check failed during ${stage}. Review local app, fixture, and database readiness without sharing credentials.`);
  process.exitCode = 1;
} finally {
  if (dbConnected) {
    let cleanupFailed = false;
    if (sessionId && userId) {
      try {
        const deleted = await db.query("DELETE FROM auth_session WHERE id = $1 AND user_id = $2", [sessionId, userId]);
        cleanupFailed ||= deleted.rowCount !== 1;
      } catch {
        cleanupFailed = true;
      }
    }
    try { await db.end(); } catch { cleanupFailed = true; }
    if (cleanupFailed) {
      console.error("Local customer session probe cleanup did not complete; inspect the isolated local test fixture.");
      process.exitCode = 1;
    }
  }
}
