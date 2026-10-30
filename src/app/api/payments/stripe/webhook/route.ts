import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripeRuntime, stripeEventMatchesMode, stripeEventMatchesProviderAccount } from "@/server/payments/stripe";
import { processVerifiedStripeEvent, requiredStripeWebhookSecret } from "@/server/wallet/topups";
import { logSafeFailure } from "@/server/observability/safe-log";
import { readBoundedUtf8Body } from "@/modules/fulfillment/webhook-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 1_000_000;
const HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "charge.dispute.created",
  "charge.dispute.closed",
  "charge.refunded",
]);

async function readBoundedRawBody(request: Request): Promise<string> {
  const lengthHeader = request.headers.get("content-length");
  const length = lengthHeader === null ? null : Number(lengthHeader);
  if (length !== null && (!Number.isSafeInteger(length) || length < 1 || length > MAX_BODY_BYTES)) {
    throw new Error("Invalid body length");
  }
  if (!request.body) throw new Error("Missing body");
  const body = await readBoundedUtf8Body(request.body, MAX_BODY_BYTES);
  if (body === null) throw new Error("Invalid or oversized body");
  if (length !== null && Buffer.byteLength(body, "utf8") !== length) throw new Error("Incomplete body");
  return body;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length <= 255 ? value : null;
}

function objectId(value: unknown): string | null {
  return stringValue(value) ?? stringValue(record(value).id);
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  let stripe: ReturnType<typeof getStripeRuntime>;
  try { stripe = getStripeRuntime(); }
  catch { return NextResponse.json({ error: "Webhook is not configured" }, { status: 503 }); }
  if (!stripe) return NextResponse.json({ error: "Webhook is not configured" }, { status: 503 });
  let secret: string;
  try { secret = requiredStripeWebhookSecret(); }
  catch { return NextResponse.json({ error: "Webhook is not configured" }, { status: 503 }); }

  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  let rawBody: string;
  try { rawBody = await readBoundedRawBody(request); }
  catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }

  let event: Stripe.Event;
  try { event = stripe.client.webhooks.constructEvent(rawBody, signature, secret); }
  catch { return NextResponse.json({ error: "Invalid signature" }, { status: 400 }); }
  if (!stripeEventMatchesMode(event.livemode, stripe.mode)) {
    return NextResponse.json({ error: "Stripe event mode does not match this environment" }, { status: 400 });
  }
  if (!HANDLED_EVENTS.has(event.type)) return NextResponse.json({ received: true, ignored: true });
  let accountEvent: Stripe.Event;
  try {
    // Fetching the signed event through the configured API key binds it to the
    // account that owns that key. Never process another account's event facts.
    accountEvent = await stripe.client.events.retrieve(event.id);
  } catch (error) {
    logSafeFailure("stripe_event_account_lookup_failed", error, requestId, { providerEventId: event.id });
    return NextResponse.json({ error: "Stripe event account could not be verified" }, { status: 500 });
  }
  if (!stripeEventMatchesProviderAccount(event, accountEvent)) {
    logSafeFailure("stripe_event_account_binding_failed", new Error("Signed and API-fetched event identities differ"), requestId, { providerEventId: event.id });
    return NextResponse.json({ error: "Stripe event account could not be verified" }, { status: 500 });
  }

  const data = record(event.data.object);
  const metadata = record(data.metadata);
  const isCheckout = event.type.startsWith("checkout.session.");
  const isDispute = event.type.startsWith("charge.dispute.");
  const paymentIntentId = objectId(data.payment_intent);
  let attemptId = stringValue(metadata.paymentAttemptId);
  if (!attemptId && !isCheckout && paymentIntentId) {
    try {
      const intent = await stripe.client.paymentIntents.retrieve(paymentIntentId);
      attemptId = stringValue(intent.metadata.paymentAttemptId);
    } catch (error) {
      logSafeFailure("stripe_event_intent_lookup_failed", error, requestId, { providerEventId: event.id, paymentAttemptId: attemptId ?? undefined });
      return NextResponse.json({ error: "Payment event could not be reconciled" }, { status: 500 });
    }
  }
  const amount = isCheckout && typeof data.amount_total === "number" ? data.amount_total
    : event.type === "charge.refunded" && typeof data.amount_refunded === "number" ? data.amount_refunded
      : isDispute && typeof data.amount === "number" ? data.amount : null;
  const eventTime = new Date(event.created * 1000);
  if (!Number.isFinite(eventTime.getTime())) return NextResponse.json({ error: "Invalid event" }, { status: 400 });

  try {
    const result = await processVerifiedStripeEvent({
      eventId: event.id,
      eventType: event.type,
      payloadHash: createHash("sha256").update(rawBody).digest("hex"),
      objectId: stringValue(data.id),
      attemptId,
      checkoutSessionId: isCheckout ? stringValue(data.id) : null,
      paymentIntentId,
      amountMinor: amount !== null && Number.isSafeInteger(amount) && amount >= 0 ? amount : null,
      currency: stringValue(data.currency),
      paymentStatus: isCheckout ? stringValue(data.payment_status) : null,
      eventCreatedAt: eventTime,
      disputeStatus: isDispute ? stringValue(data.status) : null,
      disputeId: isDispute ? stringValue(data.id) : null,
      providerStatus: stringValue(data.status) ?? (isCheckout ? stringValue(data.payment_status) : null),
    });
    if (result === "RECONCILIATION_REQUIRED") {
      console.warn(JSON.stringify({ timestamp: new Date().toISOString(), level: "warn", event: "stripe_event_requires_reconciliation", requestId, providerEventId: event.id, providerEventType: event.type }));
    }
    return NextResponse.json({ received: true, result });
  } catch (error) {
    logSafeFailure("stripe_event_processing_failed", error, requestId, { providerEventId: event.id, paymentAttemptId: attemptId ?? undefined });
    return NextResponse.json({ error: "Event processing failed" }, { status: 500 });
  }
}
