import assert from "node:assert/strict";
import test from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { serializeSignedCookie } from "better-call";
import { tsImport } from "tsx/esm/api";

test("closing staging customer access also closes existing Google accounts and signed sessions", async (t) => {
  const origin = "https://app.staging.example.test";
  t.mock.property(process, "env", {
    NODE_ENV: "production", GPHKM_DEPLOYMENT_ENV: "staging", GPHKM_STAGING_TESTER_NOTICES_ENABLED: "false",
    CUSTOMER_APP_URL: origin, STAFF_APP_URL: "https://staff.staging.example.test",
    GPHKM_TRUSTED_PROXY_CIDRS: "127.0.0.1/32", DATABASE_URL: "postgresql://gphkm_runtime@127.0.0.1:1/synthetic",
    BETTER_AUTH_SECRET: Buffer.from(Array.from({length: 32}, (_, i) => i)).toString("base64"),
    GOOGLE_CLIENT_ID: "synthetic-id", GOOGLE_CLIENT_SECRET: "synthetic-secret",
  });
  const { getAuthForSurface } = await tsImport("../src/server/auth/index.ts", import.meta.url);
  const now = new Date();
  const user = { id: "u", email: "tester@example.test", emailVerified: true, name: "Example", createdAt: now, updatedAt: now };
  const session = { id: "s", token: "synthetic-test-session", userId: user.id, createdAt: now, updatedAt: now, expiresAt: new Date(+now + 60000) };
  const store = { user: [user], session: [session], account: [{ userId: user.id, providerId: "google", accountId: "sample" }], verification: [] };
  const auth = betterAuth({ ...getAuthForSurface("customer").options, database: memoryAdapter(store), rateLimit: { enabled: false } });
  const cookieName = (await auth.$context).authCookies.sessionToken.name;
  const cookie = (await serializeSignedCookie(cookieName, session.token, process.env.BETTER_AUTH_SECRET)).split(";")[0];
  const headers = new Headers({ origin, host: new URL(origin).host, cookie });
  assert.equal(await auth.api.getSession({ headers }), null);
  const response = await auth.handler(new Request(origin + "/api/auth/get-session", { headers }));
  assert.equal(response.status, 200);
  assert.equal(await response.json(), null);
  await assert.rejects(auth.api.listSessions({ headers }), /sign-in is closed/);
  await assert.rejects(auth.api.signInSocial({ headers, body: { provider: "google", callbackURL: "/customer" } }), /sign-in is closed/);
  await auth.api.signOut({ headers });
  assert.equal(store.session.length, 0);
});
