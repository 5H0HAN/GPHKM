import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireStaffAccess } from "@/server/auth/staff";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function listUnknownCustomerEmails(headers: Headers) {
  const actor = await requireStaffAccess(headers, "supplier-report.export");
  if (actor.role !== "SUPER_ADMIN") throw new Error("Forbidden");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const result = await tx.execute(sql`select * from public.gphkm_list_unknown_customer_notification_emails()`);
    return (result as unknown as { rows?: Array<{ outbox_id: string; notification_kind: string; created_at: Date; attempts: number; error_code: string | null }> }).rows ?? [];
  });
}

export async function reconcileCustomerEmail(headers: Headers, input: {
  outboxId: string; decision: string; providerReference: string; evidenceReference: string; reason: string;
}) {
  if (!UUID.test(input.outboxId)
    || !["CONFIRMED_SENT", "CONFIRMED_NOT_SENT"].includes(input.decision)
    || (input.decision === "CONFIRMED_SENT" && !/^[A-Za-z0-9_-]{1,128}$/.test(input.providerReference))
    || (input.decision === "CONFIRMED_NOT_SENT" && input.providerReference !== "")
    || input.evidenceReference.trim().length < 3 || input.evidenceReference.length > 200
    || /[\u0000-\u001f\u007f]/.test(input.evidenceReference)
    || input.reason.trim().length < 10 || input.reason.length > 1000
    || /[\u0000-\u001f\u007f]/.test(input.reason)) throw new Error("Invalid notification reconciliation decision");
  const actor = await requireStaffAccess(headers, "supplier-report.export");
  if (actor.role !== "SUPER_ADMIN") throw new Error("Forbidden");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const result = await tx.execute(sql`select public.gphkm_reconcile_customer_notification_email(
      ${input.outboxId}, ${input.decision},
      ${input.decision === "CONFIRMED_SENT" ? input.providerReference : null},
      ${input.evidenceReference.trim()}, ${input.reason.trim()}
    ) as applied`);
    const applied = (result as unknown as { rows?: Array<{ applied: boolean }> }).rows?.[0]?.applied;
    if (!applied) throw new Error("Notification reconciliation is unavailable or already resolved");
    return { reconciled: true as const };
  });
}
