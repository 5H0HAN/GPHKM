import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { clearCustomerCart, CustomerCartConflict, getCustomerCart, getCustomerCartCount, removeCustomerCartItem, saveCustomerCartItem } from "@/server/orders/cart";
import { logSafeFailure } from "@/server/observability/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_000_000;
const response = (body: object, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new Error("Invalid cart request");
  const lengthHeader = request.headers.get("content-length");
  const declaredLength = lengthHeader === null ? null : Number(lengthHeader);
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > MAX_BODY_BYTES)) {
    throw new Error("Invalid cart request");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Invalid cart request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES || (declaredLength !== null && size > declaredLength)) {
        await reader.cancel();
        throw new Error("Invalid cart request");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== null && size !== declaredLength) throw new Error("Invalid cart request");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Invalid cart request");
  }
}

function requestOriginIsValid(request: Request) {
  try {
    return request.headers.get("origin") === new URL(process.env.CUSTOMER_APP_URL ?? "").origin;
  } catch {
    return false;
  }
}

function errorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "Unauthorized") return 401;
  if (message === "Forbidden" || message === "Marketplace access required") return 403;
  if (error instanceof CustomerCartConflict || message.startsWith("Cart listing ")) return 409;
  if (message.startsWith("Invalid ") || message.startsWith("The shared cart can contain")) return 400;
  return 500;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId") ?? "";
  if (!organizationId || organizationId.length > 128) return response({ error: "Invalid cart request" }, 400);
  try {
    if (url.searchParams.get("summary") === "1") {
      const count = await getCustomerCartCount(request.headers, organizationId);
      return response({ count });
    }
    return response(await getCustomerCart(request.headers, organizationId));
  } catch (error) {
    const status = errorStatus(error);
    const requestId = status === 500 ? randomUUID() : null;
    if (requestId) logSafeFailure("customer_cart_read_failed", error, requestId, { organizationId });
    return response({
      error: status === 500 ? "The shared cart could not be loaded." : "The shared cart is unavailable.",
      ...(requestId ? { requestId } : {}),
    }, status);
  }
}

export async function POST(request: Request) {
  if (!requestOriginIsValid(request)) return response({ error: "Invalid request origin" }, 403);
  let organizationId = "";
  try {
    const body = await readBoundedJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid cart request");
    const input = body as Record<string, unknown>;
    if (typeof input.organizationId !== "string" || input.organizationId.length > 128) throw new Error("Invalid cart request");
    organizationId = input.organizationId;
    if (input.action === "save") {
      if (Object.keys(input).some((key) => !["organizationId", "action", "listingId", "listingRevision", "version", "draft"].includes(key))) {
        throw new Error("Invalid cart request");
      }
      const result = await saveCustomerCartItem(request.headers, organizationId, {
        listingId: typeof input.listingId === "string" ? input.listingId : "",
        listingRevision: typeof input.listingRevision === "number" ? input.listingRevision : 0,
        version: typeof input.version === "number" ? input.version : -1,
        draft: input.draft,
      });
      return response(result);
    }
    if (input.action === "remove" && typeof input.listingId === "string") {
      if (Object.keys(input).some((key) => !["organizationId", "action", "listingId"].includes(key))) {
        throw new Error("Invalid cart request");
      }
      return response({ removed: await removeCustomerCartItem(request.headers, organizationId, input.listingId) });
    }
    if (input.action === "clear") {
      if (Object.keys(input).some((key) => !["organizationId", "action"].includes(key))) throw new Error("Invalid cart request");
      return response({ removed: await clearCustomerCart(request.headers, organizationId) });
    }
    throw new Error("Invalid cart request");
  } catch (error) {
    const status = errorStatus(error);
    const requestId = status === 500 ? randomUUID() : null;
    if (requestId) logSafeFailure("customer_cart_update_failed", error, requestId, { organizationId });
    const message = status === 409 ? error instanceof Error ? error.message : "The shared cart changed."
      : status === 500 ? "The shared cart could not be updated."
        : status === 403 ? "The shared cart is unavailable."
          : status === 401 ? "Sign in again to update the shared cart."
            : "Cart details could not be saved. Review them and try again.";
    return response({ error: message, ...(requestId ? { requestId } : {}) }, status);
  }
}
