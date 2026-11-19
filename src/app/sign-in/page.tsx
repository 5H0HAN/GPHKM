import { customerEmailSignupEnabled, localAuthEnabled } from "@/server/auth/policy";
import SignInForm from "./sign-in-form";
import { currentLegalDocuments } from "@/modules/legal/policy";
import { getSignInSession } from "@/server/auth/sign-in-session";
import { redirect } from "next/navigation";
import { authEmailAvailable } from "@/server/auth/email-delivery";

export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams;
  const oauthError = error === "TWO_FACTOR_REQUIRED" || error === "STAFF_IDENTITY_ON_CUSTOMER_SURFACE"
    ? error
    : typeof error === "string" && error.length > 0 ? "GOOGLE_SIGN_IN_FAILED" : undefined;
  let legalConfigured = false;
  let legalDocuments = null;
  try { legalDocuments = currentLegalDocuments(process.env); legalConfigured = true; } catch { /* Fail closed for public customer registration. */ }
  const session = await getSignInSession("customer");
  if (session) redirect("/customer");
  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
  return (
    <SignInForm
      session={session}
      oauthError={oauthError}
      localEnabled={localAuthEnabled(process.env)}
      emailPasswordEnabled={true}
      emailSignupEnabled={customerEmailSignupEnabled(process.env) && legalConfigured && authEmailAvailable()}
      googleSignupEnabled={legalConfigured && googleEnabled}
      legalDocuments={legalDocuments}
      passwordResetEnabled={authEmailAvailable()}
      googleEnabled={googleEnabled}
      legalUnavailable={!legalConfigured}
    />
  );
}
