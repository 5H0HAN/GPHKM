"use server";

import { randomUUID } from "node:crypto";
import { isAPIError } from "better-auth/api";
import { sql } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setCustomerNewsletterPreference, setCustomerNotificationEmailPreference } from "@/server/notifications/customer";
import { revokeCustomerSession, revokeOtherCustomerSessions } from "@/server/identity/customer-sessions";
import { db } from "@/db";
import { getAuthForSurface } from "@/server/auth";
import { appendAuditEvent } from "@/server/audit/append";
import { requireVerifiedCustomer } from "@/server/identity/customer-context";
import { logSafeEvent, logSafeFailure } from "@/server/observability/safe-log";

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

export async function addCustomerPasswordAction(_previous: { error: string }, form: FormData): Promise<{ error: string }> {
  const newPassword = form.get("newPassword");
  if (typeof newPassword !== "string" || newPassword.length < 16 || newPassword.length > 128) {
    return { error: "Enter a password with 16–128 characters." };
  }
  if (newPassword !== form.get("confirmPassword")) return { error: "The passwords do not match." };

  const requestHeaders = await headers();
  let userId: string;
  try {
    const actor = await requireVerifiedCustomer(requestHeaders);
    const auth = getAuthForSurface("customer");
    // Better Auth's set-password endpoint requires an authoritative session.
    // The list-sessions endpoint additionally enforces the configured fresh age.
    await auth.api.listSessions({ headers: requestHeaders });
    await auth.api.setPassword({ body: { newPassword }, headers: requestHeaders });
    userId = actor.userId;
  } catch (error) {
    const code = isAPIError(error) ? error.body?.code : undefined;
    if (code === "PASSWORD_ALREADY_SET") return { error: "You already have a password. Refresh the page and use Change password." };
    if (code === "SESSION_NOT_FRESH" || code === "SESSION_EXPIRED" || code === "UNAUTHORIZED" ||
      (error instanceof Error && error.message === "Unauthorized")) {
      return { error: "Sign in again to add a password." };
    }
    return { error: "The password could not be added. Try again." };
  }

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
      await appendAuditEvent(tx, {
        actorUserId: userId,
        action: "customer.password_added",
        targetType: "auth_user",
        targetId: userId,
      });
    });
  } catch {
    logSafeEvent("customer_password_added_audit_failed", randomUUID(), { surface: "customer" });
  }
  revalidatePath("/customer/settings");
  redirect(settingsPath(form, "updated=password-added"));
}
