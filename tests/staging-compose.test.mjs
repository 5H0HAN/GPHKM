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
    GPHKM_STAGING_WEB_PORT: "19317",
    RESEND_API_KEY: "fixture-resend-key",
    RESEND_SYSTEM_FROM_EMAIL: "no-reply@example.invalid",
    RESEND_SUPPORT_FROM_EMAIL: "support@example.invalid",
    RESEND_WEBHOOK_SECRET: "fixture-webhook-secret",
    GPHKM_INVITATION_TOKEN_ENCRYPTION_KEY: "a".repeat(64),
  };
  for (const role of ["POSTGRES", "MIGRATION", "RUNTIME", "MFAPROOF", "STRIPEWEBHOOK", "WORKER", "64_AUTH"]) {
    env[`SERVICE_PASSWORD_${role}`] = `fixture-${role}`;
  }
  const configArgs = [
    "compose", "--env-file", "/dev/null", "-f", "compose.staging.yaml", "config", "--format", "json",
  ];
  const missingPort = spawnSync("docker", configArgs, { env: { ...env, GPHKM_STAGING_WEB_PORT: "" }, encoding: "utf8" });
  assert.notEqual(missingPort.status, 0);
  assert.match(missingPort.stderr, /GPHKM_STAGING_WEB_PORT/);
  const rendered = spawnSync("docker", configArgs, { env, encoding: "utf8" });
  assert.equal(rendered.status, 0, rendered.stderr);
  const { services, networks } = JSON.parse(rendered.stdout);
  assert.equal(services.web.environment.GPHKM_STAGING_TESTER_NOTICES_ENABLED, "false");
  assert.equal(services.web.environment.GPHKM_STAGING_GOOGLE_TEST_EMAILS, "");
  assert.equal(services.web.environment.GPHKM_STAGING_REVIEW_NOTICES_ENABLED, "false");
  for (const service of ["db", "worker-role", "migrate", "web", "worker"]) {
    assert.equal(services[service].build.pull, true, `${service} pulls current base images`);
  }
  const testers = {
    GPHKM_STAGING_TESTER_NOTICES_ENABLED: "true",
    GPHKM_STAGING_GOOGLE_TEST_EMAILS: "one@example.invalid,two@example.invalid",
  };
  const enabled = spawnSync("docker", configArgs, { env: { ...env, ...testers }, encoding: "utf8" });
  assert.equal(enabled.status, 0, enabled.stderr);
  const configured = JSON.parse(enabled.stdout).services;
  for (const [name, service] of Object.entries(configured)) {
    assert.deepEqual(service.build, services[name].build);
    const runtime = { ...testers, ...service.environment };
    assert.equal(runtime.GPHKM_STAGING_TESTER_NOTICES_ENABLED, name === "web" ? "true" : "false");
    assert.equal(runtime.GPHKM_STAGING_GOOGLE_TEST_EMAILS, name === "web" ? testers.GPHKM_STAGING_GOOGLE_TEST_EMAILS : "unavailable");
  }
  assert.equal(networks.database.internal, true);
  assert.deepEqual(Object.keys(services.db.networks), ["database"]);
  assert.equal(services.db.ports, undefined);
  assert.equal(services.migrate.ports, undefined);
  assert.equal(services.web.networks.default.gw_priority, 1);
  assert.deepEqual(services.web.ports, [{
    mode: "ingress", host_ip: "127.0.0.1", target: 3000, published: env.GPHKM_STAGING_WEB_PORT, protocol: "tcp",
  }]);
  assert.equal(services.web.depends_on.migrate.condition, "service_completed_successfully");
  assert.equal(services.worker.depends_on.migrate.condition, "service_completed_successfully");
  assert.equal(services.worker.depends_on["worker-role"].condition, "service_completed_successfully");
  assert.equal(services["worker-role"].depends_on.db.condition, "service_healthy");
  assert.equal(services["worker-role"].restart, "no");
  assert.deepEqual(Object.keys(services["worker-role"].networks), ["database"]);
  assert.equal(services["worker-role"].ports, undefined);
  assert.equal(services.migrate.depends_on.db.condition, "service_healthy");
  assert.equal(services.migrate.restart, "no");
  assert.equal(services.worker.restart, "unless-stopped");
  assert.equal(services.worker.ports, undefined);
  assert.deepEqual(Object.keys(services.worker.networks).sort(), ["database", "default"]);
  for (const [service, allowed, resendAllowed] of [
    [services.web, ["RUNTIME", "MFAPROOF", "STRIPEWEBHOOK", "64_AUTH"], true],
    [services.migrate, ["MIGRATION"], false],
    [services.worker, ["WORKER"], true],
    [services["worker-role"], ["POSTGRES", "WORKER"], false],
    [services.db, ["POSTGRES", "MIGRATION", "RUNTIME", "MFAPROOF", "STRIPEWEBHOOK", "WORKER"], false],
  ]) {
    // Coolify supplies the entire resource .env as env_file on each service.
    const settings = Object.values({ ...env, ...service.environment }).join("\n");
    for (const role of ["POSTGRES", "MIGRATION", "RUNTIME", "MFAPROOF", "STRIPEWEBHOOK", "WORKER", "64_AUTH"]) {
      assert.equal(settings.includes(`fixture-${role}`), allowed.includes(role), role);
    }
    for (const key of ["RESEND_API_KEY", "RESEND_SYSTEM_FROM_EMAIL", "RESEND_SUPPORT_FROM_EMAIL", "RESEND_WEBHOOK_SECRET", "GPHKM_INVITATION_TOKEN_ENCRYPTION_KEY"]) {
      const allowed = key === "RESEND_WEBHOOK_SECRET" ? service === services.web : resendAllowed;
      assert.equal(service.environment[key] !== "unavailable", allowed, key);
    }
    for (const flag of ["GPHKM_LOCAL_AUTH_ENABLED", "GPHKM_LOCAL_MFA_DISABLED", "GPHKM_REAL_MONEY_ENABLED", "GPHKM_LAUNCH_GATES_VERIFIED"]) {
      assert.equal(service.environment[flag], "false", flag);
    }
  }
  assert.equal(services.web.environment.GPHKM_RESEND_DATA_HANDLING_APPROVED, "false");
  assert.equal(services.worker.environment.GPHKM_RESEND_DATA_HANDLING_APPROVED, "false");
  assert.equal(services.worker.environment.RESEND_WEBHOOK_SECRET, "unavailable");
});
