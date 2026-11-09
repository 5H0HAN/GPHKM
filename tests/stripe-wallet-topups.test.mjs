import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { assertStripeCheckoutEnabled, getStripeRuntime, isStripeWalletCheckoutAvailable, stripeEventMatchesMode, stripeEventMatchesProviderAccount, stripeWalletReturnUrl } from "../src/server/payments/stripe.ts";

test("live Stripe checkout remains closed until both launch flags are enabled", () => {
  const testKey = ["sk", "test", "placeholder"].join("_");
  const restrictedTestKey = ["rk", "test", "placeholder"].join("_");
  const liveKey = ["sk", "live", "placeholder"].join("_");
  const restrictedLiveKey = ["rk", "live", "placeholder"].join("_");
  assert.equal(getStripeRuntime({ STRIPE_SECRET_KEY: "" }), null);
  assert.equal(getStripeRuntime({ STRIPE_SECRET_KEY: testKey }).mode, "test");
  assert.equal(getStripeRuntime({ STRIPE_SECRET_KEY: restrictedTestKey }).mode, "test");
  assert.throws(() => getStripeRuntime({ STRIPE_SECRET_KEY: liveKey }), /restricted API key/);
  const liveRuntime = getStripeRuntime({ STRIPE_SECRET_KEY: restrictedLiveKey });
  assert.equal(liveRuntime.mode, "live");
  assert.throws(() => assertStripeCheckoutEnabled(liveRuntime, {}), /launch gates/);
  assert.throws(() => assertStripeCheckoutEnabled(liveRuntime, { GPHKM_REAL_MONEY_ENABLED: "true" }), /launch gates/);
  assert.doesNotThrow(() => assertStripeCheckoutEnabled(liveRuntime, {
    GPHKM_REAL_MONEY_ENABLED: "true", GPHKM_LAUNCH_GATES_VERIFIED: "true",
  }));
  assert.equal(isStripeWalletCheckoutAvailable({}), false);
  assert.equal(isStripeWalletCheckoutAvailable({ STRIPE_SECRET_KEY: testKey }), false);
  const webhookConfig = {
    STRIPE_WEBHOOK_SECRET: ["whsec", "placeholder"].join("_"),
    STRIPE_WEBHOOK_DATABASE_URL: "postgresql://gphkm_webhook@localhost/gphkm",
  };
  assert.equal(isStripeWalletCheckoutAvailable({ ...webhookConfig, STRIPE_SECRET_KEY: testKey, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_placeholder" }), false);
  const liveConfig = { ...webhookConfig, STRIPE_SECRET_KEY: restrictedLiveKey, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_placeholder" };
  assert.equal(isStripeWalletCheckoutAvailable(liveConfig), false);
  assert.equal(isStripeWalletCheckoutAvailable({ ...liveConfig, GPHKM_REAL_MONEY_ENABLED: "true", GPHKM_LAUNCH_GATES_VERIFIED: "true" }), true);
  assert.throws(() => getStripeRuntime({ STRIPE_SECRET_KEY: "prefix_sk_test_placeholder" }), /not recognized/);
});

test("test funding requires webhook signing and database configuration before creating attempts", () => {
  const testConfig = {
    STRIPE_SECRET_KEY: ["sk", "test", "placeholder"].join("_"),
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_placeholder",
    STRIPE_WEBHOOK_SECRET: ["whsec", "placeholder"].join("_"),
    STRIPE_WEBHOOK_DATABASE_URL: "postgresql://gphkm_webhook@localhost/gphkm",
  };
  assert.equal(isStripeWalletCheckoutAvailable(testConfig), true);
  for (const [key, invalidValue] of [
    ["STRIPE_WEBHOOK_SECRET", undefined], ["STRIPE_WEBHOOK_SECRET", "not-a-signing-secret"],
    ["STRIPE_WEBHOOK_DATABASE_URL", undefined], ["STRIPE_WEBHOOK_DATABASE_URL", "https://localhost/gphkm"],
  ]) {
    assert.equal(isStripeWalletCheckoutAvailable({ ...testConfig, [key]: invalidValue }), false);
  }
  const probe = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { POST } from "./src/app/api/customer/wallet/top-ups/route.ts";

    const origin = process.env.CUSTOMER_APP_URL;
    for (const setting of ["STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_DATABASE_URL"]) {
      const configured = process.env[setting];
      delete process.env[setting];
      const response = await POST(new Request(new URL("/api/customer/wallet/top-ups", origin), {
        method: "POST",
        headers: { host: new URL(origin).host, origin, "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "synthetic", amount: "50", idempotencyKey: "00000000-0000-4000-8000-000000000001" }),
      }));
      assert.equal(response.status, 503);
      process.env[setting] = configured;
    }
  `], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env, ...testConfig, NODE_ENV: "test", CUSTOMER_APP_URL: "http://customer.localhost:3000",
      STAFF_APP_URL: "http://staff.localhost:3000", DATABASE_URL: "postgresql://gphkm_runtime@localhost:1/gphkm",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
});

test("Stripe API requests have a bounded timeout and retry budget", () => {
  const runtime = getStripeRuntime({ STRIPE_SECRET_KEY: ["sk", "test", "placeholder"].join("_") });
  assert.equal(runtime.client.getApiField("timeout"), 15_000);
  assert.equal(runtime.client.getMaxNetworkRetries(), 1);
});

test("recharge UI hides the payment form when server configuration or live launch gates are closed", async () => {
  const page = await readFile(new URL("../src/app/customer/wallet/recharge/page.tsx", import.meta.url), "utf8");
  const checkout = await readFile(new URL("../src/app/customer/wallet/recharge/topup-checkout.tsx", import.meta.url), "utf8");
  assert.match(page, /isStripeWalletCheckoutAvailable\(\)/);
  assert.match(checkout, /if \(!checkoutAvailable\) return <p/);
  assert.match(checkout, /role="status" aria-live="polite" aria-atomic="true" className=\{customerStyles\.panelText\}>Payment confirmation is being checked/);
});

test("recharge returns to the authorized payment organization and describes the current access policy", async () => {
  const returnUrl = stripeWalletReturnUrl("org-123&session_id=other", { CUSTOMER_APP_URL: "https://customer.example" });
  const parsed = new URL(returnUrl);
  assert.equal(parsed.origin, "https://customer.example");
  assert.equal(parsed.pathname, "/customer/wallet/recharge");
  assert.equal(parsed.searchParams.get("organizationId"), "org-123&session_id=other");
  assert.deepEqual(parsed.searchParams.getAll("session_id"), ["{CHECKOUT_SESSION_ID}"]);
  assert.match(returnUrl, /session_id=\{CHECKOUT_SESSION_ID\}$/);
  const topups = await readFile(new URL("../src/server/wallet/topups.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/app/customer/wallet/recharge/page.tsx", import.meta.url), "utf8");
  const checkout = await readFile(new URL("../src/app/customer/wallet/recharge/topup-checkout.tsx", import.meta.url), "utf8");
  assert.match(topups, /return_url: stripeWalletReturnUrl\(attempt\.organizationId\)/);
  assert.match(page, /typeof params\.session_id === "string" && requestedOrganizationId === organizationId/);
  assert.match(checkout, /await result\.checkout\.confirm\(\)/);
  assert.match(checkout, /meets the current minimum grants marketplace access for the current policy term/);
  assert.doesNotMatch(checkout, /six.month|at least[^<]*50/i);
});

test("Stripe webhook events must match the configured key mode", () => {
  assert.equal(stripeEventMatchesMode(false, "test"), true);
  assert.equal(stripeEventMatchesMode(true, "live"), true);
  assert.equal(stripeEventMatchesMode(false, "live"), false);
  assert.equal(stripeEventMatchesMode(true, "test"), false);
});

test("Stripe webhook facts must match an event fetched through the configured account", async () => {
  const event = {
    id: "evt_expected", type: "checkout.session.completed", livemode: false, created: 1_800_000_000,
    data: { object: { id: "cs_expected" } },
  };
  assert.equal(stripeEventMatchesProviderAccount(event, structuredClone(event)), true);
  assert.equal(stripeEventMatchesProviderAccount(event, { ...event, id: "evt_other" }), false);
  assert.equal(stripeEventMatchesProviderAccount(event, { ...event, data: { object: { id: "cs_other" } } }), false);
  assert.equal(stripeEventMatchesProviderAccount(event, { ...event, account: "acct_connected" }), false);
  assert.equal(stripeEventMatchesProviderAccount(event, { ...event, created: 1 }), false);

  const route = await readFile(new URL("../src/app/api/payments/stripe/webhook/route.ts", import.meta.url), "utf8");
  assert.match(route, /stripe\.client\.events\.retrieve\(event\.id\)/);
  assert.ok(route.indexOf("stripe.client.events.retrieve(event.id)") < route.indexOf("processVerifiedStripeEvent({"));
  assert.match(route, /stripeEventMatchesProviderAccount\(event, accountEvent\)/);
});

test("Finance absence resolution shares the organization Stripe-risk lock", async () => {
  const migration = await readFile(new URL("../src/db/migrations/0121_serialize_stripe_checkout_absence_resolution.sql", import.meta.url), "utf8");
  const lock = migration.indexOf("pg_advisory_xact_lock(hashtextextended('gphkm:wallet-risk:' || attempt_org_id, 0))");
  const delegation = migration.indexOf("RETURN public.gphkm_resolve_missing_stripe_checkout_session_unserialized(");
  assert.ok(lock >= 0 && delegation > lock, "Finance must acquire the shared risk lock before the original organization/attempt row locks");
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.gphkm_resolve_missing_stripe_checkout_session\(text, text, text\) TO gphkm_runtime/);
  assert.match(migration, /FROM PUBLIC, gphkm_runtime/);
});
