import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
  return next(specifier, context);
} });

test("auth email delivery does not block auth responses and handles failures safely", async (t) => {
  const originalEnv = Object.fromEntries(["RESEND_API_KEY", "RESEND_SYSTEM_FROM_EMAIL", "RESEND_SUPPORT_FROM_EMAIL", "GPHKM_RESEND_DATA_HANDLING_APPROVED"].map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "synthetic-resend-key";
  process.env.RESEND_SYSTEM_FROM_EMAIL = "no-reply@example.test";
  process.env.RESEND_SUPPORT_FROM_EMAIL = "support@example.test";
  process.env.GPHKM_RESEND_DATA_HANDLING_APPROVED = "true";
  t.after(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = originalFetch;
  });

  const { sendAuthEmailInBackground } = await import("../src/server/auth/email-delivery.ts");
  let requestBody;
  let resolveSend;
  globalThis.fetch = (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Promise((resolve) => { resolveSend = resolve; });
  };
  const success = sendAuthEmailInBackground({ kind: "verification", to: "customer@example.test", subject: "Verify", text: "synthetic-link" });
  assert.equal(success, undefined);
  assert.equal(requestBody.from, "no-reply@example.test");
  assert.deepEqual(requestBody.to, ["customer@example.test"]);
  resolveSend(new Response(null, { status: 200 }));
  await new Promise((resolve) => setImmediate(resolve));

  const originalError = console.error;
  const logged = [];
  let resolveLogged;
  const failureLogged = new Promise((resolve) => { resolveLogged = resolve; });
  console.error = (message) => { logged.push(message); resolveLogged(); };
  t.after(() => { console.error = originalError; });
  globalThis.fetch = async () => new Response("provider-private-error-marker", { status: 401 });
  assert.equal(sendAuthEmailInBackground({ kind: "password_reset", to: "customer@example.test", subject: "Reset", text: "sensitive-reset-link" }), undefined);
  await failureLogged;
  const failure = JSON.parse(logged[0]);
  assert.equal(failure.event, "customer_auth_email_failed");
  assert.equal(failure.emailType, "password_reset");
  assert.equal(failure.failureClass, "provider_rejected");
  assert.equal(failure.providerStatus, 401);
  assert.match(failure.emailAttemptId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(failure).sort(), ["emailAttemptId", "emailType", "event", "failureClass", "providerStatus"]);
  assert.ok(!logged.join(" ").includes("customer@example.test"));
  assert.ok(!logged.join(" ").includes("Reset"));
  assert.ok(!logged.join(" ").includes("sensitive-reset-link"));
  assert.ok(!logged.join(" ").includes("provider-private-error-marker"));

  let networkFailureLogged;
  const networkFailure = new Promise((resolve) => { networkFailureLogged = resolve; });
  console.error = (message) => { logged.push(message); networkFailureLogged(message); };
  globalThis.fetch = async () => { throw new Error("network failure containing sensitive-reset-link"); };
  sendAuthEmailInBackground({ kind: "password_reset", to: "customer@example.test", subject: "Reset", text: "sensitive-reset-link" });
  await networkFailure;
  const networkEvent = JSON.parse(logged[1]);
  assert.equal(networkEvent.failureClass, "network_error");
  assert.equal(networkEvent.providerStatus, undefined);
  assert.deepEqual(Object.keys(networkEvent).sort(), ["emailAttemptId", "emailType", "event", "failureClass"]);
  assert.ok(!logged.join(" ").includes("customer@example.test"));
  assert.ok(!logged.join(" ").includes("Reset"));
  assert.ok(!logged.join(" ").includes("network failure"));
  assert.ok(!logged.join(" ").includes("sensitive-reset-link"));

  let unsafeKindLogged;
  const unsafeKindFailure = new Promise((resolve) => { unsafeKindLogged = resolve; });
  console.error = (message) => { logged.push(message); unsafeKindLogged(message); };
  globalThis.fetch = async () => new Response(null, { status: 401 });
  sendAuthEmailInBackground({ kind: "unexpected-recipient@example.test", to: "customer@example.test", subject: "Reset", text: "sensitive-reset-link" });
  await unsafeKindFailure;
  const unsafeKindEvent = JSON.parse(logged[2]);
  assert.equal(unsafeKindEvent.emailType, "unknown");
  assert.deepEqual(Object.keys(unsafeKindEvent).sort(), ["emailAttemptId", "emailType", "event", "failureClass", "providerStatus"]);
  assert.ok(!logged.join(" ").includes("unexpected-recipient@example.test"));
});

test("verified customer welcome email uses the configured system sender", async (t) => {
  const originalEnv = Object.fromEntries(["RESEND_API_KEY", "RESEND_SYSTEM_FROM_EMAIL", "RESEND_SUPPORT_FROM_EMAIL", "GPHKM_RESEND_DATA_HANDLING_APPROVED"].map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "synthetic-resend-key";
  process.env.RESEND_SYSTEM_FROM_EMAIL = "no-reply@example.test";
  process.env.RESEND_SUPPORT_FROM_EMAIL = "support@example.test";
  process.env.GPHKM_RESEND_DATA_HANDLING_APPROVED = "true";
  t.after(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = originalFetch;
  });

  const { sendCustomerWelcomeEmail } = await import("../src/server/auth/email-delivery.ts");
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(null, { status: 200 });
  };
  sendCustomerWelcomeEmail("customer@example.test", "https://app.example.test/sign-in");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requestBody.from, "no-reply@example.test");
  assert.deepEqual(requestBody.to, ["customer@example.test"]);
  assert.equal(requestBody.subject, "Welcome to GPHKM");
  assert.match(requestBody.text, /https:\/\/app\.example\.test\/sign-in/);
});
