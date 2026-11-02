import { STAFF_CATALOG_PAGE_SIZE, staffCatalogPagination } from "../catalog/pagination.ts";

export const CUSTOMER_DIRECTORY_MAX_PAGES = 2_000;

export function staffCustomerDirectoryPagination(requestedPage: unknown, total: number) {
  const pagination = staffCatalogPagination(requestedPage, total);
  const totalPages = Math.min(pagination.totalPages, CUSTOMER_DIRECTORY_MAX_PAGES);
  const page = Math.min(pagination.page, totalPages);
  return {
    page,
    totalPages,
    total,
    limit: STAFF_CATALOG_PAGE_SIZE,
    offset: (page - 1) * STAFF_CATALOG_PAGE_SIZE,
    truncated: pagination.totalPages > CUSTOMER_DIRECTORY_MAX_PAGES,
  };
}
