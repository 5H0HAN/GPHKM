import type { Metadata } from "next";
import ConfirmEmail from "@/app/sign-in/confirm-email";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer", robots: { index: false, follow: false } };

export default async function ConfirmStaffEmailPage({ searchParams }: {
  searchParams: Promise<{ token?: string | string[]; callbackURL?: string | string[] }>;
}) {
  const query = await searchParams;
  return <ConfirmEmail
    token={typeof query.token === "string" ? query.token : null}
    callbackURL={typeof query.callbackURL === "string" && query.callbackURL.length <= 2048 ? query.callbackURL : null}
    staff
  />;
}
