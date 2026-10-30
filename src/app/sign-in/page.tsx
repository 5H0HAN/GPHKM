import { localAuthEnabled } from "@/server/auth/policy";
import SignInForm from "./sign-in-form";
import { currentLegalDocuments } from "@/modules/legal/policy";
import { getSignInSession } from "@/server/auth/sign-in-session";
import { redirect } from "next/navigation";
import { customerAuthEmailAvailable } from "@/server/auth/email-delivery";

export const dynamic = "force-dynamic";

export default async function SignInPage() {
  let legalConfigured = false;
  try { currentLegalDocuments(process.env); legalConfigured = true; } catch { /* Fail closed for public customer registration. */ }
  const session = await getSignInSession("customer");
  if (session) redirect("/customer");
  return (
    <SignInForm
      session={session}
      localEnabled={localAuthEnabled(process.env)}
      emailPasswordEnabled={true}
      emailSignupEnabled={!localAuthEnabled(process.env) && legalConfigured && customerAuthEmailAvailable()}
      passwordResetEnabled={customerAuthEmailAvailable()}
      googleEnabled={legalConfigured && Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)}
      legalUnavailable={!legalConfigured}
    />
  );
}
