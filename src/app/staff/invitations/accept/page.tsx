import type { Metadata } from "next";
import { localStaffMfaDisabled } from "@/server/auth/policy";
import { getSignInSession } from "@/server/auth/sign-in-session";
import { StaffInvitationAcceptance } from "./staff-invitation-acceptance";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer" };

export default async function AcceptStaffInvitationPage() {
  const alreadyAccepted = Boolean(await getSignInSession("staff"));
  return <StaffInvitationAcceptance alreadyAccepted={alreadyAccepted} localMfaBypassed={localStaffMfaDisabled(process.env)} />;
}
