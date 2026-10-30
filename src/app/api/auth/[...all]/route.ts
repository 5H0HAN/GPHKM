import { getAuthForSurface } from "@/server/auth";
import { recordStaffMfaProof } from "@/server/auth/staff-mfa-proof";
import { resolveAuthSurface, type AuthSurface } from "@/server/auth/surfaces";

export const runtime = "nodejs";

async function handle(request: Request) {
  // Use the direct Host header only; X-Forwarded-Host is not trusted by this app.
  let surface: AuthSurface | null;
  try {
    surface = resolveAuthSurface(request.headers, process.env);
  } catch {
    return new Response("Authentication unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!surface) return new Response("Misdirected Request", { status: 421, headers: { "Cache-Control": "no-store" } });

  const response = await getAuthForSurface(surface).handler(request);
  if (surface !== "staff") return response;
  try { return await recordStaffMfaProof(request, response); }
  catch {
    // Do not send a session cookie if its server-side staff MFA proof could not be recorded.
    return new Response("Authentication could not be completed", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
