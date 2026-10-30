import { NextResponse } from "next/server";
import { authSurfaceOrigins, resolveAuthSurface } from "@/server/auth/surfaces";
import { acceptCustomerLegalDocuments } from "@/server/legal/consent";
import { LegalConfigurationError } from "@/modules/legal/policy";

export const runtime = "nodejs";
const response = (body: object, status: number) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function POST(request: Request) {
  try {
    if (resolveAuthSurface(request.headers, process.env) !== "customer") return response({ error: "Not found" }, 404);
    if (request.headers.get("origin") !== authSurfaceOrigins(process.env).customer) return response({ error: "Request origin rejected" }, 403);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return response({ error: "Invalid request" }, 400);
    const reader = request.body?.getReader();
    if (!reader) return response({ error: "Invalid request" }, 400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 2048) { await reader.cancel(); return response({ error: "Request too large" }, 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) return response({ error: "Invalid request" }, 400);
    const input = value as Record<string, unknown>;
    await acceptCustomerLegalDocuments(request.headers, { accepted: input.accepted, termsVersion: input.termsVersion, privacyVersion: input.privacyVersion });
    return response({ accepted: true }, 200);
  } catch (error) {
    if (error instanceof LegalConfigurationError) return response({ error: "Customer access is temporarily unavailable." }, 503);
    return response({ error: "Read and accept the current documents before continuing." }, 403);
  }
}
