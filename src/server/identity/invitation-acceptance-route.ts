import { NextResponse } from "next/server";
import { authSurfaceOrigins, resolveAuthSurface, type AuthSurface } from "@/server/auth/surfaces";
import { acceptOrganizationInvitation } from "./organization-lifecycle";
import { acceptStaffInvitation } from "./staff-lifecycle";

const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

export async function handleInvitationAcceptance(request: Request, surface: AuthSurface) {
  if (resolveAuthSurface(request.headers, process.env) !== surface) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: noStore });
  }
  if (request.headers.get("origin") !== authSurfaceOrigins(process.env)[surface]) {
    return NextResponse.json({ error: "Request origin rejected" }, { status: 403, headers: noStore });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > 1024) return NextResponse.json({ error: "Request too large" }, { status: 413, headers: noStore });

  let raw: string;
  try {
    if (!request.body) throw new Error("Missing body");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024) {
        await reader.cancel();
        return NextResponse.json({ error: "Request too large" }, { status: 413, headers: noStore });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: noStore });
  }

  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: noStore }); }
  if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || typeof (body as { token?: unknown }).token !== "string"
      || !/^[A-Za-z0-9_-]{40,64}$/.test((body as { token: string }).token)) {
    return NextResponse.json({ error: "Invitation unavailable" }, { status: 400, headers: noStore });
  }

  try {
    const token = (body as { token: string }).token;
    if (surface === "customer") {
      const result = await acceptOrganizationInvitation(request.headers, token);
      return NextResponse.json({ accepted: true, organizationId: result.organizationId }, { status: 200, headers: noStore });
    }
    await acceptStaffInvitation(request.headers, token);
    return NextResponse.json({ accepted: true }, { status: 200, headers: noStore });
  } catch (error) {
    const status = error instanceof Error && error.message === "Unauthorized" ? 401 : 400;
    return NextResponse.json({ error: "Invitation unavailable" }, { status, headers: noStore });
  }
}
