import assert from "node:assert/strict";
import test from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { serializeSignedCookie } from "better-call";
import { tsImport } from "tsx/esm/api";

test("only currently designated verified Google testers receive customer access with preliminary notices", async (t) => {
  const email = "designated@example.test";
  const origin = "https://app.example.test";
  t.mock.property(process, "env", {
    NODE_ENV: "production", CUSTOMER_APP_URL: origin, STAFF_APP_URL: "https://staff.example.test",
    GPHKM_STAGING_TESTER_NOTICES_ENABLED: "true", GPHKM_DEPLOYMENT_ENV: "staging",
    GPHKM_REAL_MONEY_ENABLED: "false", GPHKM_LAUNCH_GATES_VERIFIED: "false",
    GPHKM_STAGING_GOOGLE_TEST_EMAILS: email, GPHKM_TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
    DATABASE_URL: "postgresql://gphkm_runtime@127.0.0.1:1/synthetic",
    MFA_PROOF_DATABASE_URL: "postgresql://gphkm_mfa_proof@127.0.0.1:1/synthetic",
    BETTER_AUTH_SECRET: Buffer.from(Array.from({length: 32}, (_, i) => i)).toString("base64"),
    GOOGLE_CLIENT_ID: "synthetic-id", GOOGLE_CLIENT_SECRET: "synthetic-secret",
  });
  const { getAuthForSurface } = await tsImport("../src/server/auth/index.ts", import.meta.url);
  const options = getAuthForSurface("customer").options;
  assert.equal(options.emailAndPassword.enabled, false);
  assert.equal(getAuthForSurface("staff").options.emailAndPassword.enabled, true);
  assert.deepEqual(getAuthForSurface("staff").options.socialProviders, {});
  const checkProfile = options.socialProviders.google.mapProfileToUser;
  assert.deepEqual(checkProfile({ email: email.toUpperCase(), email_verified: true }), {});
  for (const [address, verified] of [[email, false], [email, "true"], ["other@example.test", true], [undefined, true]]) {
    assert.throws(() => checkProfile({ email: address, email_verified: verified }), /designated Google/);
  }
  const userHook = options.databaseHooks.user.create.before;
  for (const [path, provider, address] of [["/sign-up/email", undefined, email], ["/callback/:id", "google", "other@example.test"]]) {
    await assert.rejects(userHook({email:address, emailVerified:true}, {path, params:{id:provider}}), /designated Google/);
  }
  await assert.rejects(options.databaseHooks.session.create.before({userId:"u"}, {path:"/sign-in/email"}), /designated Google/);

  const now = new Date();
  const store = {
    user: [{id:"u", name:"Tester", email, emailVerified:true, createdAt:now, updatedAt:now}],
    session: [{id:"s", token:"synthetic-session-token", userId:"u", createdAt:now, updatedAt:now, expiresAt:new Date(+now + 86400000)}],
    account: [], verification: [], rateLimit: [],
  };
  const auth = betterAuth({...options, database:memoryAdapter(store), rateLimit:{enabled:false}});
  const { currentLegalDocuments } = await tsImport("../src/modules/legal/policy.ts", import.meta.url);
  const docs = currentLegalDocuments(process.env);
  const start = {provider:"google", requestSignUp:true, callbackURL:origin + "/customer"};
  await assert.rejects(auth.api.signInSocial({body:start}), /Accept the current Terms and Privacy/);
  const consent = {accepted:true, termsVersion:docs.termsVersion, privacyVersion:docs.privacyVersion};
  const redirect = await auth.api.signInSocial({body:{...start, additionalData:{legalConsent:consent}}});
  const google = new URL(redirect.url);
  assert.equal(google.hostname, "accounts.google.com");
  assert.deepEqual(google.searchParams.get("scope").split(" ").sort(), ["email", "openid", "profile"]);
  const cookieName = (await auth.$context).authCookies.sessionToken.name;
  async function sessionHeaders(secret) {
    const cookie = (await serializeSignedCookie(cookieName, store.session[0].token, secret)).split(";")[0];
    return new Headers({host:"app.example.test", origin, cookie});
  }
  assert.equal(await auth.api.getSession({ headers:await sessionHeaders(process.env.BETTER_AUTH_SECRET) }), null);
  const headers = await sessionHeaders(options.secret);
  assert.equal((await auth.api.getSession({ headers })).user.email, email);
  assert.equal((await auth.api.listSessions({ headers })).length, 1);
  for (const [path, body] of [
    ["/sign-in/email", {email, password:"synthetic-password"}],
    ["/sign-up/email", {name:"Tester", email, password:"synthetic-password"}],
    ["/sign-in/social", {provider:"google", idToken:{token:"synthetic"}}],
    ["/sign-in/social", {provider:"google", scopes:["unused-scope"]}],
  ]) {
    const result = await auth.handler(new Request(origin + "/api/auth" + path, {
      method:"POST", headers:{"content-type":"application/json", origin}, body:JSON.stringify(body),
    }));
    assert.equal(result.status, 403, path);
  }
  await assert.rejects(auth.api.setPassword({ headers, body:{newPassword:"synthetic-password"} }), /designated Google/);
  process.env.GPHKM_STAGING_GOOGLE_TEST_EMAILS = "replacement@example.test";
  assert.throws(() => checkProfile({ email, email_verified:true }), /designated Google/);
  assert.equal(await auth.api.getSession({ headers }), null);
  await assert.rejects(auth.api.listSessions({ headers }), /designated Google/);
  await assert.rejects(auth.api.revokeOtherSessions({ headers }), /designated Google/);
  assert.equal(store.session.length, 1);
  process.env.GPHKM_STAGING_GOOGLE_TEST_EMAILS = email;
  process.env.GPHKM_LAUNCH_GATES_VERIFIED = "true";
  assert.equal(await auth.api.getSession({ headers }), null);
  assert.throws(() => checkProfile({ email, email_verified:true }), /designated Google/);
});
