import "server-only";
import { sql } from "drizzle-orm";
import { getResendWebhookDb } from "@/db/resend-webhook";

export async function processCustomerNotificationEmailWebhook(input: {
  eventId: string; eventType: string; emailId: string; taggedOutboxId: string | null;
  payloadHash: string; eventCreatedAt: Date;
}) {
  return getResendWebhookDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.resend_webhook_verified', 'true', true)`);
    const result = await tx.execute(sql`select * from public.gphkm_process_customer_notification_email_event(
      ${input.eventId}, ${input.eventType}, ${input.emailId}, ${input.taggedOutboxId}, ${input.payloadHash}, ${input.eventCreatedAt}
    )`);
    return (result as unknown as { rows?: Array<{ matched: boolean; duplicate: boolean; result_state: string }> }).rows?.[0]
      ?? { matched: false, duplicate: false, result_state: "RECONCILIATION_REQUIRED" };
  });
}
