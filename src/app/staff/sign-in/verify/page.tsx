import type { Metadata } from "next";
import SignInForm from "@/app/sign-in/sign-in-form";
import { authEmailAvailable } from "@/server/auth/email-delivery";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer" };

export default function VerifyStaffSignInPage() {
  return <SignInForm
    session={null}
    localEnabled={false}
    emailPasswordEnabled={false}
    emailSignupEnabled={false}
    googleEnabled={false}
    passwordResetEnabled={authEmailAvailable()}
    verify
    returnTo="/staff/sign-in"
    surface="staff"
  />;
}
