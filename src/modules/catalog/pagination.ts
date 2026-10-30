export const STAFF_CATALOG_PAGE_SIZE = 50;

export function staffCatalogPagination(requestedPage: unknown, total: number) {
  const value = typeof requestedPage === "string" && /^[1-9]\d*$/.test(requestedPage)
    ? Number(requestedPage) : requestedPage;
  const totalPages = Math.max(1, Math.ceil(total / STAFF_CATALOG_PAGE_SIZE));
  const page = typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, totalPages) : 1;
  return { page, totalPages, total, limit: STAFF_CATALOG_PAGE_SIZE, offset: (page - 1) * STAFF_CATALOG_PAGE_SIZE };
}
