"use server";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setCustomerNewsletterPreference, setCustomerNotificationEmailPreference } from "@/server/notifications/customer";
import { revokeCustomerSession, revokeOtherCustomerSessions } from "@/server/identity/customer-sessions";
import { logSafeFailure } from "@/server/observability/safe-log";

function logSettingsFailure(event: string, error: unknown) {
  logSafeFailure(event, error, randomUUID());
}

function settingsPath(form: FormData, query: string) {
  const organizationId = form.get("organizationId");
  const suffix = typeof organizationId === "string" && organizationId.length > 0
    ? `&organizationId=${encodeURIComponent(organizationId)}`
    : "";
  return `/customer/settings?${query}${suffix}`;
}

export async function saveNotificationPreference(form: FormData) {
  const enabled = form.get("transactionalEmailEnabled");
  if (enabled !== "true" && enabled !== "false") redirect(settingsPath(form, "notificationError=1"));
  try { await setCustomerNotificationEmailPreference(await headers(), enabled === "true"); }
  catch (error) { logSettingsFailure("customer_notification_preference_failed", error); redirect(settingsPath(form, "notificationError=1")); }
  revalidatePath("/customer/settings");
  redirect(settingsPath(form, "updated=notifications"));
}

export async function saveNewsletterPreference(form: FormData) {
  const subscribed = form.get("newsletterSubscribed");
  if (subscribed !== "true" && subscribed !== "false") redirect(settingsPath(form, "newsletterError=1"));
  try { await setCustomerNewsletterPreference(await headers(), subscribed === "true"); }
  catch (error) { logSettingsFailure("customer_newsletter_preference_failed", error); redirect(settingsPath(form, "newsletterError=1")); }
  revalidatePath("/customer/settings");
  redirect(settingsPath(form, "updated=newsletter"));
}

export async function revokeSessionAction(form: FormData) {
  const sessionId = form.get("sessionId");
  if (typeof sessionId !== "string") redirect(settingsPath(form, "sessionError=1"));
  try { await revokeCustomerSession(await headers(), sessionId); }
  catch (error) { logSettingsFailure("customer_session_revocation_failed", error); redirect(settingsPath(form, "sessionError=1")); }
  revalidatePath("/customer/settings");
  redirect(settingsPath(form, "sessions=updated"));
}

export async function revokeOtherSessionsAction(form: FormData) {
  if (form.get("confirmed") !== "on") redirect(settingsPath(form, "sessionError=1"));
  try { await revokeOtherCustomerSessions(await headers()); }
  catch (error) { logSettingsFailure("customer_other_sessions_revocation_failed", error); redirect(settingsPath(form, "sessionError=1")); }
  revalidatePath("/customer/settings");
  redirect(settingsPath(form, "sessions=updated"));
}
