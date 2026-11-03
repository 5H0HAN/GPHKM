import { requireStaffAccess } from "@/server/auth/staff";
import { getStaffOperationsAlerts } from "@/server/observability/operations-alerts";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(request: Request) {
  let actor: Awaited<ReturnType<typeof requireStaffAccess>>;
  try {
    actor = await requireStaffAccess(request.headers, "audit.read");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    const status = reason === "Unauthorized" ? 401 : reason === "Forbidden" ? 403 : 503;
    return Response.json({ error: status === 401 || status === 403 ? "Staff access is no longer available." : "Overview could not be refreshed." }, { status, headers });
  }

  try {
    const alerts = await getStaffOperationsAlerts(request.headers, actor);
    return Response.json({ alerts, checkedAt: new Date().toISOString() }, { headers });
  } catch {
    return Response.json({ error: "Overview could not be refreshed." }, { status: 503, headers });
  }
}
