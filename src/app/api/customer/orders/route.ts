import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createWalletFundedOrder } from "@/server/orders/checkout";
import { logSafeFailure } from "@/server/observability/safe-log";

const MAX_BODY_BYTES = 2_000_000;

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new Error("Invalid request");
  const lengthHeader = request.headers.get("content-length");
  const length = lengthHeader === null ? null : Number(lengthHeader);
  if (length !== null && (!Number.isSafeInteger(length) || length < 1 || length > MAX_BODY_BYTES)) throw new Error("Invalid request");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Invalid request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES || (length !== null && size > length)) throw new Error("Invalid request");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length !== null && size !== length) throw new Error("Invalid request");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function POST(request: Request) {
  let requestedOrganizationId: string | undefined;
  let customerOrigin: string;
  try { customerOrigin = new URL(process.env.CUSTOMER_APP_URL ?? "").origin; }
  catch { return NextResponse.json({ error: "Checkout is unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  if (request.headers.get("origin") !== customerOrigin) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const value = await readBoundedJson(request);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
    const body = value as Record<string, unknown>;
    if (typeof body.organizationId !== "string") throw new Error("Invalid request");
    requestedOrganizationId = body.organizationId;
    const result = await createWalletFundedOrder(request.headers, body.organizationId, body.order);
    return NextResponse.json(result, { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status = message === "Unauthorized" ? 401
      : message === "Forbidden" || message === "Marketplace access required" ? 403
        : message === "Invalid order details" ? 400
          : message.includes("Insufficient available wallet balance") || message.includes("idempotency")
            || message.includes("reconciliation") || message.includes("listings changed") || message.includes("listings are unavailable")
            || message.includes("Writing is not available") ? 409 : 500;
    const requestId = status === 500 ? randomUUID() : null;
    const headers = { "Cache-Control": "no-store", ...(requestId ? { "X-Request-ID": requestId } : {}) };
    if (requestId) logSafeFailure("customer_order_checkout_failed", error, requestId, { organizationId: requestedOrganizationId });
    const userMessage = status === 409 ? "Your order needs a review. Refresh the catalog or check your available wallet balance."
      : status === 403 ? "Marketplace access is required to place an order."
        : status === 401 ? "Sign in again to continue."
          : status === 500 ? `Order checkout could not be completed. Contact support with reference ${requestId}.`
            : "Order details could not be accepted. Review them and try again.";
    return NextResponse.json({ error: userMessage }, { status, headers });
  }
}
