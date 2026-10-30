import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { processResendWebhook } from "@/server/fulfillment/packets";
import { verifyResendWebhook } from "@/server/fulfillment/resend-webhook";
import { readBoundedUtf8Body } from "@/modules/fulfillment/webhook-body";
import { processCustomerNotificationEmailWebhook } from "@/server/notifications/provider-events";
import { logSafeFailure } from "@/server/observability/safe-log";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = randomUUID();
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > 64 * 1024) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  const body = await readBoundedUtf8Body(request.body, 64 * 1024);
  if (body === null) return NextResponse.json({ error: "Payload too large or invalid encoding" }, { status: 413 });
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const eventId = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (!secret || !verifyResendWebhook({ body, eventId, timestamp, signature, secret })) {
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });
  }
  let event: unknown;
  try { event = JSON.parse(body); } catch { return NextResponse.json({ error: "Invalid webhook body" }, { status: 400 }); }
  if (!event || typeof event !== "object") return NextResponse.json({ error: "Invalid webhook body" }, { status: 400 });
  const root = event as Record<string, unknown>;
  const data = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : null;
  if (typeof root.type !== "string" || !data || typeof data.email_id !== "string") {
    return NextResponse.json({ error: "Invalid webhook event" }, { status: 400 });
  }
  try {
    const packetAttemptTag = data.tags && typeof data.tags === "object" && !Array.isArray(data.tags)
      ? Object.hasOwn(data.tags, "gphkm_packet_attempt")
        ? { present: true, value: (data.tags as Record<string, unknown>).gphkm_packet_attempt }
        : { present: false, value: null }
      : Array.isArray(data.tags)
        ? (() => {
          const tag = (data.tags as Array<{ name?: unknown; value?: unknown }>).find((item) => item?.name === "gphkm_packet_attempt");
          return { present: Boolean(tag), value: tag?.value ?? null };
        })()
        : { present: false, value: null };
    const tagValue = data.tags && typeof data.tags === "object" && !Array.isArray(data.tags)
      ? (data.tags as Record<string, unknown>).gphkm_outbox
      : Array.isArray(data.tags)
        ? (data.tags as Array<{ name?: unknown; value?: unknown }>).find((tag) => tag?.name === "gphkm_outbox")?.value
        : null;
    if (typeof tagValue === "string") {
      const eventTime = typeof root.created_at === "string" ? new Date(root.created_at)
        : typeof data.created_at === "string" ? new Date(data.created_at) : null;
      if (!eventTime || !Number.isFinite(eventTime.getTime())) return NextResponse.json({ error: "Invalid event time" }, { status: 400 });
      const result = await processCustomerNotificationEmailWebhook({
        eventId: eventId!, eventType: root.type, emailId: data.email_id, taggedOutboxId: tagValue,
        payloadHash: createHash("sha256").update(body).digest("hex"), eventCreatedAt: eventTime,
      });
      return NextResponse.json({ received: true, ...result });
    }
    const result = await processResendWebhook({
      body, eventId: eventId!, eventType: root.type, emailId: data.email_id,
      taggedAttemptId: packetAttemptTag.present ? typeof packetAttemptTag.value === "string" ? packetAttemptTag.value : "" : null,
      payloadHash: createHash("sha256").update(body).digest("hex"),
    });
    return NextResponse.json({ received: true, ...result });
  } catch (error) {
    logSafeFailure("resend_webhook_processing_failed", error, requestId, { providerEventId: eventId ?? undefined });
    return NextResponse.json({ error: "Webhook processing requires reconciliation" }, { status: 500 });
  }
}
