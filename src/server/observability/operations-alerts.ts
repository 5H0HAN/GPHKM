import "server-only";
import { listFulfillmentQueue } from "@/server/fulfillment/admin";
import { listSupplierPacketReconciliation } from "@/server/fulfillment/packets";
import { getStripeWalletReconciliation, listOpenStripeAttempts } from "@/server/wallet/topups";
import { getLatestFinanceReconciliation } from "@/server/wallet/finance-reconciliation";
import { hasStaffPermission, type StaffRole } from "@/server/identity/policy";

export type OperationsAlert = {
  key: string;
  title: string;
  description: string;
  count: number;
  saturated: boolean;
  href: string;
};

export async function getStaffOperationsAlerts(headers: Headers, role: StaffRole): Promise<OperationsAlert[]> {
  const alerts: OperationsAlert[] = [];
  const work: Promise<void>[] = [];
  if (hasStaffPermission(role, "fulfillment.manage")) {
    work.push((async () => {
      const queue = await listFulfillmentQueue(headers, 1, "active");
      if (queue.overdueCount > 0) alerts.push({ key: "overdue-orders", title: "Customer updates overdue", description: "Review assigned placements and send the promised next update.", count: queue.overdueCount, saturated: false, href: "/staff/fulfillment" });
    })());
    work.push((async () => {
      const data = await listSupplierPacketReconciliation(headers);
      const count = data.attempts.length + data.unmatchedEvents.length + data.unpacketItems.length + data.heldPackets.length;
      if (count > 0) alerts.push({
        key: "supplier-handoffs", title: "Supplier handoff needs review",
        description: "Resolve unknown sends, delivery follow-ups, held packets, or eligible items without a packet.",
        count, saturated: data.attempts.length >= 200 || data.unmatchedEvents.length >= 100 || data.unpacketItems.length >= 200 || data.heldPackets.length >= 100,
        href: "/staff/fulfillment/packets/reconciliation",
      });
    })());
  }
  if (hasStaffPermission(role, "wallet.reconcile")) {
    work.push((async () => {
      const events = await getStripeWalletReconciliation(headers);
      if (events.length > 0) alerts.push({ key: "payment-events", title: "Payment events need reconciliation", description: "Review provider events, active holds, and unmatched funding facts.", count: events.length, saturated: events.length >= 200, href: "/staff/reconciliation" });
    })());
    work.push((async () => {
      const attempts = await listOpenStripeAttempts(headers);
      if (attempts.length > 0) alerts.push({ key: "open-payment-attempts", title: "Wallet funding attempts remain open", description: "Review pending attempts and confirm their provider outcome.", count: attempts.length, saturated: attempts.length >= 100, href: "/staff/reconciliation" });
    })());
    work.push((async () => {
      const snapshot = await getLatestFinanceReconciliation(headers);
      const unresolved = snapshot?.findings.filter((finding) => finding.outcome === null || finding.outcome === "FOLLOW_UP_REQUIRED").length ?? 0;
      if (unresolved > 0) alerts.push({ key: "wallet-findings", title: "Wallet reconciliation findings remain open", description: "Review findings that need a Finance decision or follow-up evidence.", count: unresolved, saturated: unresolved >= 500, href: "/staff/reconciliation" });
    })());
  }
  await Promise.all(work);
  return alerts.sort((a, b) => a.key.localeCompare(b.key));
}
