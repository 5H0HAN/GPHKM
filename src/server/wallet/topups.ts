import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import Stripe from "stripe";
import { db } from "@/db";
import { getStripeWebhookDb } from "@/db/stripe-webhook";
import { paymentAttempt } from "@/db/schema";
import { parseUsdMinorUnits } from "@/modules/wallet/usd-amount";
import { requireVerifiedCustomer, withOrganizationContext, withProtectedOrganizationContext } from "@/server/identity/customer-context";
import { requireStaffAccess } from "@/server/auth/staff";
import { assertStripeCheckoutEnabled, getStripeRuntime, getStripeWebhookSecret, isDefinitiveCheckoutSessionCreateFailure } from "@/server/payments/stripe";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function trustedCustomerReturnUrl(): string {
  const configured = process.env.CUSTOMER_APP_URL?.trim();
  if (!configured) throw new Error("Customer checkout is not configured");
  const base = new URL(configured);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && !base.hostname.endsWith(".localhost")) {
    throw new Error("Customer checkout is not configured");
  }
  const result = new URL("/customer/wallet/recharge", base);
  result.search = "?session_id={CHECKOUT_SESSION_ID}";
  return result.toString();
}

export async function createStripeWalletTopUp(
  headers: Headers,
  organizationId: string,
  amountText: string,
  idempotencyKey: string,
) {
  const stripe = getStripeRuntime();
  if (!stripe) throw new Error("Stripe checkout is not configured");
  assertStripeCheckoutEnabled(stripe);
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim();
  const expectedPublishablePrefix = stripe.mode === "live" ? "pk_live_" : "pk_test_";
  if (!publishableKey?.startsWith(expectedPublishablePrefix)) throw new Error("Stripe checkout mode is not configured");
  if (!UUID.test(idempotencyKey)) throw new Error("Invalid idempotency key");
  const amountMinor = parseUsdMinorUnits(amountText);
  const actor = await requireVerifiedCustomer(headers);
  const requestHash = createHash("sha256").update(`USD:${amountMinor}`).digest("hex");
  const attemptId = randomUUID();

  const attempt = await withProtectedOrganizationContext(headers, organizationId, async (tx, role) => {
    if (role !== "OWNER") throw new Error("Only an organization Owner can fund the wallet");
    await tx.execute(sql`select public.gphkm_create_stripe_topup_attempt(
      ${attemptId}, ${amountMinor.toString()}, ${idempotencyKey}, ${requestHash})`);
    const [row] = await tx.select().from(paymentAttempt).where(and(
      eq(paymentAttempt.organizationId, organizationId),
      eq(paymentAttempt.actorUserId, actor.userId),
      eq(paymentAttempt.idempotencyKey, idempotencyKey),
    )).limit(1);
    if (!row || !["CREATED", "PENDING"].includes(row.state)) throw new Error("This funding attempt requires reconciliation");
    if (row.amountMinor !== amountMinor.toString()) throw new Error("Funding idempotency conflict");
    return row;
  });

  let session: Stripe.Checkout.Session;
  if (attempt.providerCheckoutSessionId) {
    session = await stripe.client.checkout.sessions.retrieve(attempt.providerCheckoutSessionId);
  } else {
    const { rows } = await withOrganizationContext(headers, organizationId, (tx) =>
      tx.execute(sql`select public.gphkm_begin_stripe_checkout_session_create(${attempt.id}) as may_create`));
    if ((rows[0] as { may_create?: boolean } | undefined)?.may_create !== true) {
      throw new Error("Stripe checkout outcome requires reconciliation before another session can be created");
    }
    const suffix = attempt.id.replaceAll("-", "").slice(0, 8).split("")
      .map((character) => String.fromCharCode(97 + Number.parseInt(character, 16))).join("");
    try {
      session = await stripe.client.checkout.sessions.create({
        integration_identifier: `gphkm-wallet-${suffix}`,
        ui_mode: "custom",
        mode: "payment",
        return_url: trustedCustomerReturnUrl(),
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Number(amountMinor),
            product_data: { name: "GPHKM wallet top-up" },
          },
        }],
        metadata: { paymentAttemptId: attempt.id },
        payment_intent_data: { metadata: { paymentAttemptId: attempt.id } },
      }, { idempotencyKey: `gphkm-topup-${attempt.id}` });
    } catch (error) {
      if (!isDefinitiveCheckoutSessionCreateFailure(error)) {
        throw new Error("Stripe session outcome is unclear; retry the same request");
      }
      try {
        await withOrganizationContext(headers, organizationId, async (tx) => {
          await tx.execute(sql`select public.gphkm_fail_stripe_topup_attempt(${attempt.id})`);
        });
      } catch {
        throw new Error("Stripe session outcome is unclear; retry the same request");
      }
      throw new Error("Stripe checkout is temporarily unavailable");
    }
    await withOrganizationContext(headers, organizationId, async (tx) => {
      await tx.execute(sql`select public.gphkm_attach_stripe_checkout_session(${attempt.id}, ${session.id})`);
    });
  }
  if (!session.client_secret) throw new Error("Stripe checkout requires reconciliation");
  return {
    paymentAttemptId: attempt.id,
    checkoutSessionClientSecret: session.client_secret,
    amountMinor: amountMinor.toString(),
    currency: "USD" as const,
    publishableKey,
  };
}

export async function processVerifiedStripeEvent(input: {
  eventId: string;
  eventType: string;
  payloadHash: string;
  objectId: string | null;
  attemptId: string | null;
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  amountMinor: number | null;
  currency: string | null;
  paymentStatus: string | null;
  eventCreatedAt: Date;
  disputeStatus: string | null;
  disputeId: string | null;
  providerStatus: string | null;
}) {
  const webhookDb = getStripeWebhookDb();
  return webhookDb.transaction(async (tx) => {
    // Supplemental guard for normalized fact attachment. The isolated database
    // role, not this caller-settable GUC, enforces the webhook trust boundary.
    await tx.execute(sql`select set_config('app.stripe_webhook_verified', 'true', true)`);
    const { rows } = await tx.execute(sql`select public.gphkm_process_stripe_event(
      ${input.eventId}, ${input.eventType}, ${input.payloadHash}, ${input.objectId},
      ${input.attemptId}, ${input.checkoutSessionId}, ${input.paymentIntentId},
      ${input.amountMinor}, ${input.currency}, ${input.paymentStatus}, ${input.eventCreatedAt},
      ${input.disputeStatus}, ${input.disputeId}) as result`);
    const result = (rows[0] as { result: string } | undefined)?.result ?? "RECONCILIATION_REQUIRED";
    await tx.execute(sql`select public.gphkm_attach_stripe_event_facts(
      ${input.eventId}, ${input.payloadHash}, ${input.amountMinor}, ${input.currency?.toLowerCase() ?? null}, ${input.providerStatus})`);
    return result;
  });
}

export function requiredStripeWebhookSecret(): string {
  const secret = getStripeWebhookSecret();
  if (!secret) throw new Error("Stripe webhook is not configured");
  return secret;
}

export async function getStripeWalletReconciliation(headers: Headers) {
  const staff = await requireStaffAccess(headers, "wallet.reconcile");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${staff.userId}, true)`);
    const { rows } = await tx.execute(sql`select * from public.gphkm_list_stripe_reconciliation_with_facts()`);
    return rows as Array<{
      provider_event_id: string;
      event_type: string;
      event_state: string;
      received_at: Date;
      payment_attempt_id: string | null;
      organization_id: string | null;
      attempt_state: string | null;
      topup_amount_minor: string | null;
      topup_currency: string | null;
      provider_amount_minor: string | null;
      provider_currency: string | null;
      provider_status: string | null;
      topup_ledger_id: string | null;
      active_hold_minor: string;
      hold_reason: string | null;
    }>;
  });
}

export async function listOpenStripeAttempts(headers: Headers) {
  const staff = await requireStaffAccess(headers, "wallet.reconcile");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${staff.userId}, true)`);
    const { rows } = await tx.execute(sql`select * from public.gphkm_list_open_stripe_attempts()`);
    return rows as Array<{
      payment_attempt_id: string;
      organization_id: string;
      attempt_state: "CREATED" | "PENDING";
      amount_minor: string;
      currency: string;
      created_at: Date;
      updated_at: Date;
      has_provider_session: boolean;
    }>;
  });
}

export async function listAmbiguousStripeCheckoutAttempts(headers: Headers) {
  const staff = await requireStaffAccess(headers, "wallet.reconcile");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${staff.userId}, true)`);
    const { rows } = await tx.execute(sql`select * from public.gphkm_list_ambiguous_stripe_checkout_attempts()`);
    return rows as Array<{
      payment_attempt_id: string;
      organization_id: string;
      amount_minor: string;
      currency: string;
      created_at: Date;
      dispatch_started_at: Date;
      has_related_provider_event: boolean;
      eligible_for_evidence_resolution: boolean;
    }>;
  });
}
