import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("staging Compose keeps migration credentials, provider gates and port exposure scoped", (t) => {
  if (spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status !== 0) {
    return t.skip("Docker Compose is required to render deployment settings");
  }
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CUSTOMER_APP_URL: "https://app.example.invalid",
    STAFF_APP_URL: "https://staff.example.invalid",
    GPHKM_PUBLIC_BASE_URL: "https://example.invalid",
    GPHKM_TRUSTED_PROXY_CIDRS: "127.0.0.1",
  };
  for (const role of ["POSTGRES", "MIGRATION", "RUNTIME", "MFAPROOF", "STRIPEWEBHOOK", "64_AUTH"]) {
    env[`SERVICE_PASSWORD_${role}`] = `fixture-${role}`;
  }
  const rendered = spawnSync("docker", [
    "compose", "--env-file", "/dev/null", "-f", "compose.staging.yaml", "config", "--format", "json",
  ], { env, encoding: "utf8" });
  assert.equal(rendered.status, 0, rendered.stderr);
  const { services, networks } = JSON.parse(rendered.stdout);
  assert.equal(networks.database.internal, true);
  assert.deepEqual(Object.keys(services.db.networks), ["database"]);
  for (const service of Object.values(services)) assert.equal(service.ports, undefined);
  assert.equal(services.web.depends_on.migrate.condition, "service_completed_successfully");
  assert.equal(services.migrate.depends_on.db.condition, "service_healthy");
  assert.equal(services.migrate.restart, "no");
  for (const [service, allowed] of [[services.web, ["RUNTIME", "MFAPROOF", "STRIPEWEBHOOK", "64_AUTH"]], [services.migrate, ["MIGRATION"]]]) {
    // Coolify supplies the entire resource .env as env_file on each service.
    const settings = Object.values({ ...env, ...service.environment }).join("\n");
    for (const role of ["POSTGRES", "MIGRATION", "RUNTIME", "MFAPROOF", "STRIPEWEBHOOK", "64_AUTH"]) {
      assert.equal(settings.includes(`fixture-${role}`), allowed.includes(role), role);
    }
    for (const flag of ["GPHKM_LOCAL_AUTH_ENABLED", "GPHKM_LOCAL_MFA_DISABLED", "GPHKM_REAL_MONEY_ENABLED", "GPHKM_LAUNCH_GATES_VERIFIED"]) {
      assert.equal(service.environment[flag], "false", flag);
    }
  }
  assert.equal(services.web.environment.GPHKM_RESEND_DATA_HANDLING_APPROVED, "false");
});
