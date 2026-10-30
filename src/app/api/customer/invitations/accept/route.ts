import { handleInvitationAcceptance } from "@/server/identity/invitation-acceptance-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleInvitationAcceptance(request, "customer");
}
