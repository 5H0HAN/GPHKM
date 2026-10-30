import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { readFileSync } from "node:fs";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
  const paths = {
    "@/db": "../src/db/index.ts",
    "@/db/schema": "../src/db/schema.ts",
    "@/modules/legal/policy": "../src/modules/legal/policy.ts",
    "@/server/identity/policy": "../src/server/identity/policy.ts",
    "./surfaces": "../src/server/auth/surfaces.ts",
  };
  if (paths[specifier]) return { url: new URL(paths[specifier], import.meta.url).href, shortCircuit: true };
  if (specifier === "./policy" && context.parentURL?.endsWith("/src/server/auth/index.ts")) {
    return { url: new URL("../src/server/auth/policy.ts", import.meta.url).href, shortCircuit: true };
  }
  if (specifier === "./email-delivery" && context.parentURL?.endsWith("/src/server/auth/index.ts")) {
    return { url: new URL("../src/server/auth/email-delivery.ts", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });

test("auth configuration disables local public signup and restricts profile updates", async (t) => {
  const values = {
    NODE_ENV: "development", GPHKM_LOCAL_AUTH_ENABLED: "true",
    DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/synthetic",
    CUSTOMER_APP_URL: "http://customer.localhost:3000",
    STAFF_APP_URL: "http://staff.localhost:3000",
    BETTER_AUTH_SECRET: "synthetic-offline-secret-with-at-least-32-characters",
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { getAuthForSurface } = await import("../src/server/auth/index.ts");
  const auth = getAuthForSurface("customer");
  assert.equal(auth.options.emailAndPassword.enabled, true);
  assert.equal(auth.options.emailAndPassword.requireEmailVerification, true);
  assert.equal(auth.options.emailAndPassword.disableSignUp, true);
  assert.equal(auth.options.account.accountLinking.enabled, false);
  assert.equal(auth.options.baseURL, "http://customer.localhost:3000");
  assert.deepEqual(auth.options.trustedOrigins, ["http://customer.localhost:3000"]);
  assert.equal(auth.options.advanced?.crossSubDomainCookies, undefined);
  assert.equal(typeof auth.options.hooks?.before, "function");
  const staffAuth = getAuthForSurface("staff");
  assert.equal(auth.options.emailAndPassword.disableSignUp, true);
  assert.equal(staffAuth.options.emailAndPassword.disableSignUp, true);
  assert.equal(staffAuth.options.baseURL, "http://staff.localhost:3000");
  assert.deepEqual(staffAuth.options.trustedOrigins, ["http://staff.localhost:3000"]);
  const authSource = readFileSync(new URL("../src/server/auth/index.ts", import.meta.url), "utf8");
  assert.match(authSource, /context\.path === "\/update-user"/);
  assert.match(authSource, /Object\.keys\(body\)\.some\(\(key\) => key !== "name"\)/);
  assert.match(authSource, /body\.name = normalizeDisplayName\(body\.name\)/);
  process.env.NODE_ENV = "production";
  assert.throws(() => getAuthForSurface("customer"), /requires NODE_ENV=development/);
});
