import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { customerNewsletterConsentEvent, customerNotification, customerNotificationPreference } from "@/db/notification-schema";
import { requireVerifiedCustomer, withOrganizationContext } from "@/server/identity/customer-context";
import { currentNewsletterNoticeVersion } from "@/modules/legal/policy";
import { staffCatalogPagination } from "@/modules/catalog/pagination";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function getCustomerNotifications(headers: Headers, organizationId: string, requestedPage?: unknown) {
  await requireVerifiedCustomer(headers);
  return withOrganizationContext(headers, organizationId, async (tx) => {
    const scope = eq(customerNotification.organizationId, organizationId);
    const [total] = await tx.select({ count: sql<number>`count(*)::int` }).from(customerNotification).where(scope);
    const pagination = staffCatalogPagination(requestedPage, total?.count ?? 0);
    const rows = await tx.select({
      id: customerNotification.id,
      kind: customerNotification.kind,
      title: customerNotification.title,
      body: customerNotification.body,
      orderItemId: customerNotification.orderItemId,
      supportCaseId: customerNotification.supportCaseId,
      readAt: customerNotification.readAt,
      createdAt: customerNotification.createdAt,
    }).from(customerNotification).where(scope)
      .orderBy(desc(customerNotification.createdAt), desc(customerNotification.id)).limit(pagination.limit).offset(pagination.offset);
    const [unread] = await tx.select({ count: sql<number>`count(*)::int` }).from(customerNotification)
      .where(and(eq(customerNotification.organizationId, organizationId), isNull(customerNotification.readAt)));
    return { rows, unreadCount: unread?.count ?? 0, pagination };
  });
}

export async function markCustomerNotificationRead(headers: Headers, organizationId: string, notificationId: string) {
  if (!UUID.test(notificationId)) throw new Error("Notification is unavailable");
  const actor = await requireVerifiedCustomer(headers);
  return withOrganizationContext(headers, organizationId, async (tx) => {
    await tx.update(customerNotification).set({ readAt: new Date() }).where(and(
      eq(customerNotification.id, notificationId),
      eq(customerNotification.organizationId, organizationId),
      eq(customerNotification.recipientUserId, actor.userId),
      isNull(customerNotification.readAt),
    ));
  });
}

export async function getCustomerNotificationEmailPreference(headers: Headers) {
  const actor = await requireVerifiedCustomer(headers);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const [row] = await tx.select({ enabled: customerNotificationPreference.transactionalEmailEnabled })
      .from(customerNotificationPreference).where(eq(customerNotificationPreference.userId, actor.userId)).limit(1);
    return row?.enabled ?? true;
  });
}

export async function setCustomerNotificationEmailPreference(headers: Headers, enabled: boolean) {
  if (typeof enabled !== "boolean") throw new Error("Invalid notification preference");
  const actor = await requireVerifiedCustomer(headers);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    await tx.insert(customerNotificationPreference).values({ userId: actor.userId, transactionalEmailEnabled: enabled, updatedAt: new Date() })
      .onConflictDoUpdate({ target: customerNotificationPreference.userId, set: { transactionalEmailEnabled: enabled, updatedAt: new Date() } });
  });
}

export async function getCustomerNewsletterPreference(headers: Headers) {
  const actor = await requireVerifiedCustomer(headers);
  const configuredVersion = currentNewsletterNoticeVersion(process.env);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const [row] = await tx.select({ state: customerNewsletterConsentEvent.state,
      noticeVersion: customerNewsletterConsentEvent.noticeVersion, updatedAt: customerNewsletterConsentEvent.createdAt })
      .from(customerNewsletterConsentEvent).where(eq(customerNewsletterConsentEvent.userId, actor.userId))
      .orderBy(desc(customerNewsletterConsentEvent.createdAt), desc(customerNewsletterConsentEvent.id)).limit(1);
    return { subscribed: row?.state === "SUBSCRIBED", configured: configuredVersion !== null,
      noticeVersion: row?.noticeVersion ?? null, updatedAt: row?.updatedAt ?? null };
  });
}

export async function setCustomerNewsletterPreference(headers: Headers, subscribed: boolean) {
  if (typeof subscribed !== "boolean") throw new Error("Invalid newsletter preference");
  const actor = await requireVerifiedCustomer(headers);
  const noticeVersion = subscribed ? currentNewsletterNoticeVersion(process.env) : null;
  if (subscribed && !noticeVersion) throw new Error("Newsletter consent notice is not configured");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const result = await tx.execute(sql`select * from public.gphkm_set_customer_newsletter_consent(
      ${randomUUID()}, ${subscribed}, ${noticeVersion})`);
    const row = (result as unknown as { rows?: Array<{ subscribed: boolean; changed: boolean; notice_version: string }> }).rows?.[0];
    if (!row) throw new Error("Newsletter preference could not be saved");
    return { subscribed: row.subscribed, changed: row.changed };
  });
}
