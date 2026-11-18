import type { Metadata } from "next";
import { ResetPasswordForm } from "../../../sign-in/reset-password-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer" };

export default function StaffResetPasswordPage() {
  return <ResetPasswordForm surface="staff" />;
}
