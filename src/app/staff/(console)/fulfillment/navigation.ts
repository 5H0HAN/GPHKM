const FULFILLMENT_ITEM_ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export type FulfillmentItemResult = "packet-required" | "delivery-required" | "update-failed" | "follow-up-failed" | "follow-up-updated" | "next-update-date" | "hold-reason" | "updated";
export type FulfillmentQueueResult = "updated" | "assignment-failed";

export function isFulfillmentItemId(value: string): boolean {
  return FULFILLMENT_ITEM_ID.test(value);
}

export function fulfillmentItemRedirectTarget(itemId: string, result: FulfillmentItemResult): string {
  if (!isFulfillmentItemId(itemId)) return "/staff/fulfillment?invalid-item=1";
  const query = new URLSearchParams(result === "updated" ? [["updated", "1"]]
    : result === "follow-up-updated" ? [["followUpUpdated", "1"]]
      : [["error", result]]);
  return `/staff/fulfillment/${itemId}?${query.toString()}`;
}

export function fulfillmentQueueRedirectTarget(page: unknown, view: unknown, result: FulfillmentQueueResult): string {
  const query = new URLSearchParams();
  if (typeof page === "string" && /^[1-9]\d{0,15}$/.test(page) && Number.isSafeInteger(Number(page))) query.set("page", page);
  if (view === "all") query.set("view", "all");
  query.set(result, "1");
  return `/staff/fulfillment?${query.toString()}`;
}

export function isSafeStaffNavigationTarget(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/staff/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const target = new URL(value, "https://staff.invalid");
    return target.origin === "https://staff.invalid" && target.pathname.startsWith("/staff/") && target.username === "" && target.password === "";
  } catch {
    return false;
  }
}
