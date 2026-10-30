"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setCustomerNewsletterPreference, setCustomerNotificationEmailPreference } from "@/server/notifications/customer";
import { revokeCustomerSession, revokeOtherCustomerSessions } from "@/server/identity/customer-sessions";

export async function saveNotificationPreference(form: FormData) {
  const enabled = form.get("transactionalEmailEnabled");
  if (enabled !== "true" && enabled !== "false") throw new Error("Invalid notification preference");
  await setCustomerNotificationEmailPreference(await headers(), enabled === "true");
  revalidatePath("/customer/settings");
  redirect("/customer/settings?updated=notifications");
}

export async function saveNewsletterPreference(form: FormData) {
  const subscribed = form.get("newsletterSubscribed");
  if (subscribed !== "true" && subscribed !== "false") throw new Error("Invalid newsletter preference");
  try { await setCustomerNewsletterPreference(await headers(), subscribed === "true"); }
  catch { redirect("/customer/settings?newsletterError=1"); }
  revalidatePath("/customer/settings");
  redirect("/customer/settings?updated=newsletter");
}

export async function revokeSessionAction(form: FormData) {
  const sessionId = form.get("sessionId");
  if (typeof sessionId !== "string") throw new Error("Invalid session");
  try { await revokeCustomerSession(await headers(), sessionId); }
  catch { redirect("/customer/settings?sessionError=1"); }
  revalidatePath("/customer/settings");
  redirect("/customer/settings?sessions=updated");
}

export async function revokeOtherSessionsAction(form: FormData) {
  if (form.get("confirmed") !== "on") throw new Error("Confirmation is required");
  try { await revokeOtherCustomerSessions(await headers()); }
  catch { redirect("/customer/settings?sessionError=1"); }
  revalidatePath("/customer/settings");
  redirect("/customer/settings?sessions=updated");
}
