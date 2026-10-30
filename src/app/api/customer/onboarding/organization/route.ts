import { NextResponse } from "next/server";
import { authSurfaceOrigins, resolveAuthSurface } from "@/server/auth/surfaces";
import { createFirstOrganization } from "@/server/identity/organization-lifecycle";
import { LegalAcceptanceRequiredError, LegalConfigurationError } from "@/modules/legal/policy";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const surface = resolveAuthSurface(request.headers, process.env);
  if (surface !== "customer") return NextResponse.json({ error: "Not found" }, { status: 404 });

  const expectedOrigin = authSurfaceOrigins(process.env).customer;
  if (request.headers.get("origin") !== expectedOrigin) {
    return NextResponse.json({ error: "Request origin rejected" }, { status: 403 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > 2048) return NextResponse.json({ error: "Request too large" }, { status: 413 });

  let raw: string;
  try {
    if (!request.body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2048) {
        await reader.cancel();
        return NextResponse.json({ error: "Request too large" }, { status: 413 });
      }
      chunks.push(value);
    }
    const bodyBytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bodyBytes.set(chunk, offset); offset += chunk.byteLength; }
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { name?: unknown }).name !== "string") {
    return NextResponse.json({ error: "Organization name is required" }, { status: 400 });
  }

  try {
    const value = body as Record<string, unknown>;
    const organization = await createFirstOrganization(request.headers, value.name as string, {
      accepted: value.accepted, termsVersion: value.termsVersion, privacyVersion: value.privacyVersion,
    });
    return NextResponse.json({ organization }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status = message === "Unauthorized" ? 401 : error instanceof LegalConfigurationError ? 503
      : error instanceof LegalAcceptanceRequiredError ? 403 : message.includes("safe characters") ? 400 : 500;
    const safeMessage = status === 503 ? "Customer registration is temporarily unavailable."
      : status === 403 ? "Read and accept the current Terms and Privacy documents before continuing."
        : status === 500 ? "Organization setup failed" : message;
    return NextResponse.json({ error: safeMessage }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
