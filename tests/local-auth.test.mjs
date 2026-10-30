import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./surfaces") {
    return { url: new URL("../src/server/auth/surfaces.ts", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { assertBootstrapAvailable, assertLoopbackUrl, bootstrapSettings, localAuthEnabled } = await import("../src/server/auth/policy.ts");

test("local credentials require explicit development opt-in", () => {
  assert.equal(localAuthEnabled({ NODE_ENV: "development" }), false);
  assert.equal(localAuthEnabled({ NODE_ENV: "production", GPHKM_LOCAL_AUTH_ENABLED: "false" }), false);
  assert.equal(localAuthEnabled({ NODE_ENV: "development", GPHKM_LOCAL_AUTH_ENABLED: "true" }), true);
  for (const NODE_ENV of ["production", "test", undefined]) {
    assert.throws(() => localAuthEnabled({ NODE_ENV, GPHKM_LOCAL_AUTH_ENABLED: "true" }), /requires NODE_ENV=development/);
  }
  assert.throws(() => localAuthEnabled({ NODE_ENV: "development", GPHKM_LOCAL_AUTH_ENABLED: "1" }), /must be true or false/);
});

test("bootstrap has no credentials defaults and accepts only separate local test identities", () => {
  const env = {
    NODE_ENV: "development", GPHKM_LOCAL_AUTH_ENABLED: "true",
    CUSTOMER_APP_URL: "http://customer.localhost:3000", STAFF_APP_URL: "http://staff.localhost:3000",
    MIGRATION_DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:5432/synthetic",
    BOOTSTRAP_SUPER_ADMIN_EMAIL: "admin@local.test", BOOTSTRAP_SUPER_ADMIN_PASSWORD: "synthetic-password-admin",
    BOOTSTRAP_CUSTOMER_EMAIL: "customer@local.test", BOOTSTRAP_CUSTOMER_PASSWORD: "synthetic-password-customer",
  };
  assert.equal(bootstrapSettings(env).customerEmail, env.BOOTSTRAP_CUSTOMER_EMAIL);
  for (const key of ["BOOTSTRAP_SUPER_ADMIN_EMAIL", "BOOTSTRAP_SUPER_ADMIN_PASSWORD", "BOOTSTRAP_CUSTOMER_EMAIL", "BOOTSTRAP_CUSTOMER_PASSWORD", "MIGRATION_DATABASE_URL", "CUSTOMER_APP_URL", "STAFF_APP_URL"]) {
    assert.throws(() => bootstrapSettings({ ...env, [key]: "" }), /required/);
  }
  assert.throws(() => bootstrapSettings({ ...env, BOOTSTRAP_CUSTOMER_EMAIL: env.BOOTSTRAP_SUPER_ADMIN_EMAIL }), /separate identities/);
  assert.throws(() => bootstrapSettings({ ...env, BOOTSTRAP_CUSTOMER_EMAIL: "someone@example.com" }), /reserved .test/);
  assert.throws(() => bootstrapSettings({ ...env, BOOTSTRAP_SUPER_ADMIN_PASSWORD: "short" }), /16–128/);
  assert.throws(() => bootstrapSettings({ ...env, MIGRATION_DATABASE_URL: "postgres://synthetic:synthetic@production.example.test/db" }), /loopback/);
  assert.throws(() => assertLoopbackUrl("invalid-secret", "URL"), (error) => !error.message.includes("invalid-secret"));
});

test("one-time setup cannot repeat or elevate an existing user", () => {
  assert.doesNotThrow(() => assertBootstrapAvailable(false, false, false));
  assert.throws(() => assertBootstrapAvailable(true, false, false), /staff account already exists/);
  assert.throws(() => assertBootstrapAvailable(false, true, false), /already been used/);
  assert.throws(() => assertBootstrapAvailable(false, false, true), /cannot elevate/);
});
