import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authEmailAvailable } from "@/server/auth/email-delivery";
import { localAuthEnabled, localStaffMfaDisabled } from "@/server/auth/policy";
import { getStaffSignInState } from "@/server/auth/sign-in-session";
import { requireStaffAccess } from "@/server/auth/staff";
import { StaffSignIn } from "./staff-sign-in";

export const dynamic = "force-dynamic";

export default async function StaffSignInPage() {
  const requestHeaders = await headers();
  const { session, staff } = await getStaffSignInState(requestHeaders);
  let workspaceReady = false;
  if (session && staff?.active) {
    try {
      await requireStaffAccess(requestHeaders, "audit.read");
      workspaceReady = true;
    } catch { /* Keep the page available if the current staff authority check fails. */ }
  }
  if (workspaceReady) redirect("/staff");
  return <StaffSignIn
    session={session}
    staff={staff}
    localEnabled={localAuthEnabled(process.env)}
    localMfaBypassed={localStaffMfaDisabled(process.env)}
    passwordResetEnabled={authEmailAvailable()}
  />;
}
