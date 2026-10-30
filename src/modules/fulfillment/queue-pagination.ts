export const FULFILLMENT_QUEUE_PAGE_SIZE = 100;

export function fulfillmentQueueView(requestedView: unknown): "active" | "all" {
  return requestedView === "all" ? "all" : "active";
}

export function fulfillmentQueuePagination(requestedPage: unknown, total: number) {
  const value = typeof requestedPage === "string" && /^[1-9]\d*$/.test(requestedPage)
    ? Number(requestedPage) : requestedPage;
  const pageCount = Math.max(1, Math.ceil(total / FULFILLMENT_QUEUE_PAGE_SIZE));
  const page = typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, pageCount) : 1;
  return { page, pageCount, total, offset: (page - 1) * FULFILLMENT_QUEUE_PAGE_SIZE };
}
