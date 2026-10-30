import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createStripeWalletTopUp } from "@/server/wallet/topups";
import { logSafeFailure } from "@/server/observability/safe-log";

const MAX_BODY_BYTES = 16_384;

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
  catch { return NextResponse.json({ error: "Wallet funding is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  if (request.headers.get("origin") !== customerOrigin) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const value = await readBoundedJson(request);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
    const body = value as Record<string, unknown>;
    if (typeof body.organizationId !== "string" || typeof body.amount !== "string" || typeof body.idempotencyKey !== "string") {
      throw new Error("Invalid request");
    }
    requestedOrganizationId = body.organizationId;
    const result = await createStripeWalletTopUp(request.headers, body.organizationId, body.amount, body.idempotencyKey);
    return NextResponse.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const status = message === "Unauthorized" ? 401
      : message === "Forbidden" || message.includes("Only an organization Owner") ? 403
      : message.includes("test mode") || message.includes("not configured") || message.includes("launch gates") || message.includes("temporarily unavailable") ? 503
        : message.includes("requires reconciliation") || message.includes("idempotency") || message.includes("outcome is unclear") || code === "23505" ? 409
          : message === "Invalid request" || message === "Invalid idempotency key" || message.includes("USD amount") ? 400 : 500;
    const requestId = status >= 500 ? randomUUID() : null;
    if (requestId) logSafeFailure("customer_wallet_topup_failed", error, requestId, { organizationId: requestedOrganizationId });
    const userMessage = status === 403 ? "Only an organization Owner can add wallet funds."
      : status === 401 ? "Sign in again to continue."
      : status === 503 ? "Wallet funding is temporarily unavailable."
        : status === 409 ? "This top-up needs review before it can continue."
          : status === 500 ? `Wallet funding could not be completed. Contact support with reference ${requestId}.`
            : "Top-up details could not be accepted. Check the amount and try again.";
    return NextResponse.json({ error: userMessage }, { status, headers: { "Cache-Control": "no-store", ...(requestId ? { "X-Request-ID": requestId } : {}) } });
  }
}
