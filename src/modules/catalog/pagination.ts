export const STAFF_CATALOG_PAGE_SIZE = 50;

export function staffCatalogPagination(
  requestedPage: unknown,
  total: number,
  requestedPageSize = STAFF_CATALOG_PAGE_SIZE,
) {
  const pageSize = Number.isSafeInteger(requestedPageSize) && requestedPageSize > 0 && requestedPageSize <= 1_000
    ? requestedPageSize : STAFF_CATALOG_PAGE_SIZE;
  const value = typeof requestedPage === "string" && /^[1-9]\d*$/.test(requestedPage)
    ? Number(requestedPage) : requestedPage;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, totalPages) : 1;
  return { page, totalPages, total, limit: pageSize, offset: (page - 1) * pageSize };
}
