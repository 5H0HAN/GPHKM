import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
  return next(specifier, context);
} });

test("auth email delivery returns its task to Better Auth's background handler", async (t) => {
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
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(null, { status: 200 });
  };
  const success = sendAuthEmailInBackground({ to: "customer@example.test", subject: "Verify", text: "synthetic-link" });
  assert.ok(success instanceof Promise);
  await success;
  assert.equal(requestBody.from, "no-reply@example.test");
  assert.deepEqual(requestBody.to, ["customer@example.test"]);

  const originalError = console.error;
  const logged = [];
  console.error = (message) => logged.push(message);
  t.after(() => { console.error = originalError; });
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(
    sendAuthEmailInBackground({ to: "customer@example.test", subject: "Reset", text: "sensitive-reset-link" }),
    /Customer authentication email delivery failed/,
  );
  assert.deepEqual(logged, [JSON.stringify({ event: "customer_auth_email_failed" })]);
  assert.ok(!logged.join(" ").includes("sensitive-reset-link"));
});
