import "server-only";
import Stripe from "stripe";
import { getStripeWebhookDatabaseUrl } from "../../db/stripe-webhook.ts";

export type StripeRuntime = { client: Stripe; mode: "test" | "live" };

export function stripeWalletReturnUrl(organizationId: string, env: Record<string, string | undefined> = process.env): string {
  const configured = env.CUSTOMER_APP_URL?.trim();
  if (!configured) throw new Error("Customer checkout is not configured");
  const base = new URL(configured);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && !base.hostname.endsWith(".localhost")) {
    throw new Error("Customer checkout is not configured");
  }
  const result = new URL("/customer/wallet/recharge", base);
  result.searchParams.set("organizationId", organizationId);
  result.search += "&session_id={CHECKOUT_SESSION_ID}";
  return result.toString();
}

export function getStripeRuntime(env: Record<string, string | undefined> = process.env): StripeRuntime | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  const mode = /^(?:sk|rk)_live_/.test(key) ? "live" : /^(?:sk|rk)_test_/.test(key) ? "test" : null;
  if (!mode) throw new Error("Stripe key type is not recognized");
  if (mode === "live" && !key.startsWith("rk_live_")) {
    throw new Error("Live Stripe integrations require a restricted API key");
  }
  return {
    client: new Stripe(key, {
      apiVersion: "2026-09-30.endive",
      timeout: 15_000,
      maxNetworkRetries: 1,
    }),
    mode,
  };
}

export function assertStripeCheckoutEnabled(runtime: StripeRuntime, env: Record<string, string | undefined> = process.env): void {
  if (runtime.mode === "live" && (env.GPHKM_REAL_MONEY_ENABLED !== "true" || env.GPHKM_LAUNCH_GATES_VERIFIED !== "true")) {
    throw new Error("Live Stripe checkout is disabled until real-money launch gates are approved");
  }
}

export function requireStripeWalletPublishableKey(runtime: StripeRuntime, env: Record<string, string | undefined> = process.env): string {
  assertStripeCheckoutEnabled(runtime, env);
  const publishableKey = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim();
  const prefix = runtime.mode === "live" ? "pk_live_" : "pk_test_";
  if (!publishableKey?.startsWith(prefix) || publishableKey.length === prefix.length) {
    throw new Error("Stripe checkout mode is not configured");
  }
  if (!getStripeWebhookSecret(env) || !getStripeWebhookDatabaseUrl(env)) {
    throw new Error("Stripe webhook is not configured");
  }
  return publishableKey;
}

export function isStripeWalletCheckoutAvailable(env: Record<string, string | undefined> = process.env): boolean {
  try {
    const runtime = getStripeRuntime(env);
    if (!runtime) return false;
    requireStripeWalletPublishableKey(runtime, env);
    return true;
  } catch {
    return false;
  }
}

export function isDefinitiveCheckoutSessionCreateFailure(error: unknown): boolean {
  if (!(error instanceof Stripe.errors.StripeError)) return false;
  if (error instanceof Stripe.errors.StripeIdempotencyError) return false;
  return error instanceof Stripe.errors.StripeInvalidRequestError
    || error instanceof Stripe.errors.StripeAuthenticationError
    || error instanceof Stripe.errors.StripePermissionError
    || error instanceof Stripe.errors.StripeRateLimitError;
}

export function stripeEventMatchesMode(livemode: boolean, mode: StripeRuntime["mode"]): boolean {
  return livemode === (mode === "live");
}

export function stripeEventMatchesProviderAccount(signedEvent: Stripe.Event, providerEvent: Stripe.Event): boolean {
  const signedObjectId = (signedEvent.data.object as { id?: unknown }).id;
  const providerObjectId = (providerEvent.data.object as { id?: unknown }).id;
  return typeof signedObjectId === "string" && signedObjectId.length > 0
    && signedEvent.id === providerEvent.id
    && signedEvent.type === providerEvent.type
    && signedEvent.livemode === providerEvent.livemode
    && signedEvent.created === providerEvent.created
    && signedObjectId === providerObjectId
    && (signedEvent.account ?? null) === null
    && (providerEvent.account ?? null) === null;
}

export function getStripeWebhookSecret(env: Record<string, string | undefined> = process.env): string | null {
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  return secret && /^whsec_\S+$/.test(secret) ? secret : null;
}
