import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./surfaces") {
    return { url: new URL("../src/server/auth/surfaces.ts", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { assertBootstrapAvailable, assertLoopbackUrl, bootstrapSettings, customerEmailSignupEnabled, localAuthEnabled, localStaffMfaDisabled, requiredMfaProofDatabaseUrl } = await import("../src/server/auth/policy.ts");

test("local credentials require explicit development opt-in", () => {
  assert.equal(localAuthEnabled({ NODE_ENV: "development" }), false);
  assert.equal(localAuthEnabled({ NODE_ENV: "production", GPHKM_LOCAL_AUTH_ENABLED: "false" }), false);
  assert.equal(localAuthEnabled({ NODE_ENV: "development", GPHKM_LOCAL_AUTH_ENABLED: "true" }), true);
  for (const NODE_ENV of ["production", "test", undefined]) {
    assert.throws(() => localAuthEnabled({ NODE_ENV, GPHKM_LOCAL_AUTH_ENABLED: "true" }), /requires NODE_ENV=development/);
  }
  assert.throws(() => localAuthEnabled({ NODE_ENV: "development", GPHKM_LOCAL_AUTH_ENABLED: "1" }), /must be true or false/);
});

test("local customer email signup requires a separate explicit opt-in", () => {
  assert.equal(customerEmailSignupEnabled({ NODE_ENV: "development", GPHKM_LOCAL_AUTH_ENABLED: "true" }), false);
  assert.equal(customerEmailSignupEnabled({ NODE_ENV: "development", GPHKM_LOCAL_AUTH_ENABLED: "true", GPHKM_LOCAL_CUSTOMER_EMAIL_SIGNUP_ENABLED: "false" }), false);
  assert.equal(customerEmailSignupEnabled({ NODE_ENV: "development", GPHKM_LOCAL_AUTH_ENABLED: "true", GPHKM_LOCAL_CUSTOMER_EMAIL_SIGNUP_ENABLED: "true" }), true);
  assert.equal(customerEmailSignupEnabled({ NODE_ENV: "production" }), true);
  for (const env of [
    { NODE_ENV: "production", GPHKM_LOCAL_CUSTOMER_EMAIL_SIGNUP_ENABLED: "true" },
    { NODE_ENV: "development", GPHKM_LOCAL_CUSTOMER_EMAIL_SIGNUP_ENABLED: "true" },
    { NODE_ENV: "development", GPHKM_LOCAL_AUTH_ENABLED: "true", GPHKM_LOCAL_CUSTOMER_EMAIL_SIGNUP_ENABLED: "1" },
  ]) assert.throws(() => customerEmailSignupEnabled(env), /requires development-only|must be true or false/);
});

test("staff MFA bypass is development-only and requires local authentication", () => {
  assert.equal(localStaffMfaDisabled({ NODE_ENV: "development", GPHKM_LOCAL_AUTH_ENABLED: "true", GPHKM_LOCAL_MFA_DISABLED: "true" }), true);
  assert.equal(localStaffMfaDisabled({ NODE_ENV: "development", GPHKM_LOCAL_AUTH_ENABLED: "true", GPHKM_LOCAL_MFA_DISABLED: "false" }), false);
  assert.equal(localStaffMfaDisabled({ NODE_ENV: "production", GPHKM_LOCAL_MFA_DISABLED: "false" }), false);
  for (const env of [
    { NODE_ENV: "production", GPHKM_LOCAL_AUTH_ENABLED: "true", GPHKM_LOCAL_MFA_DISABLED: "true" },
    { NODE_ENV: "development", GPHKM_LOCAL_MFA_DISABLED: "true" },
    { NODE_ENV: "development", GPHKM_LOCAL_AUTH_ENABLED: "true", GPHKM_LOCAL_MFA_DISABLED: "1" },
  ]) assert.throws(() => localStaffMfaDisabled(env), /development-only|must be true or false/);
});

test("staff MFA proof storage requires its restricted database identity", () => {
  const url = "postgres://gphkm_mfa_proof:secret@127.0.0.1:54329/gphkm";
  assert.equal(requiredMfaProofDatabaseUrl({ MFA_PROOF_DATABASE_URL: url, DATABASE_URL: "postgres://gphkm_runtime:other@127.0.0.1:54329/gphkm" }), url);
  assert.throws(() => requiredMfaProofDatabaseUrl({}), /MFA_PROOF_DATABASE_URL is required/);
  assert.throws(() => requiredMfaProofDatabaseUrl({ MFA_PROOF_DATABASE_URL: "postgres://gphkm_runtime:secret@127.0.0.1:54329/gphkm" }), /restricted gphkm_mfa_proof/);
  assert.throws(() => requiredMfaProofDatabaseUrl({ MFA_PROOF_DATABASE_URL: url, DATABASE_URL: url }), /must not use the application runtime connection/);
});

test("bootstrap has no credentials defaults and accepts only separate local test identities", () => {
  const env = {
    NODE_ENV: "development", GPHKM_LOCAL_AUTH_ENABLED: "true",
    CUSTOMER_APP_URL: "http://localhost:3000", STAFF_APP_URL: "http://staff.localhost:3000",
    MIGRATION_DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:5432/synthetic",
    BOOTSTRAP_SUPER_ADMIN_EMAIL: "admin@local.test", BOOTSTRAP_SUPER_ADMIN_PASSWORD: "synthetic-password-admin",
    BOOTSTRAP_CUSTOMER_EMAIL: "customer@local.test", BOOTSTRAP_CUSTOMER_PASSWORD: "synthetic-password-customer",
  };
  assert.equal(bootstrapSettings(env).customerEmail, env.BOOTSTRAP_CUSTOMER_EMAIL);
  assert.equal(bootstrapSettings({ ...env, BOOTSTRAP_CUSTOMER_EMAIL: "client@guestpost.local" }).customerEmail, "client@guestpost.local");
  for (const key of ["BOOTSTRAP_SUPER_ADMIN_EMAIL", "BOOTSTRAP_SUPER_ADMIN_PASSWORD", "BOOTSTRAP_CUSTOMER_EMAIL", "BOOTSTRAP_CUSTOMER_PASSWORD", "MIGRATION_DATABASE_URL", "CUSTOMER_APP_URL", "STAFF_APP_URL"]) {
    assert.throws(() => bootstrapSettings({ ...env, [key]: "" }), /required/);
  }
  assert.throws(() => bootstrapSettings({ ...env, BOOTSTRAP_CUSTOMER_EMAIL: env.BOOTSTRAP_SUPER_ADMIN_EMAIL }), /separate identities/);
  assert.throws(() => bootstrapSettings({ ...env, BOOTSTRAP_CUSTOMER_EMAIL: "someone@guestpost.local" }), /reserved .test/);
  assert.throws(() => bootstrapSettings({ ...env, BOOTSTRAP_SUPER_ADMIN_EMAIL: "admin@guestpost.local" }), /reserved .test/);
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
