const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// One customer orders page is bounded to 50 orders × 25 placements.
export const MAX_CUSTOMER_EQUIVALENT_OFFER_ITEMS = 1250;

export function assertCustomerEquivalentOfferItemIds(itemIds: readonly string[]) {
  if (itemIds.length > MAX_CUSTOMER_EQUIVALENT_OFFER_ITEMS || itemIds.some((id) => !UUID.test(id))) {
    throw new Error("Equivalent offers are unavailable");
  }
}
