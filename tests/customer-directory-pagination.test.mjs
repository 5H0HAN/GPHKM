import assert from "node:assert/strict";
import test from "node:test";
import { CUSTOMER_DIRECTORY_MAX_PAGES, staffCustomerDirectoryPagination } from "../src/modules/identity/customer-directory-pagination.ts";

test("customer directory pagination keeps ordinary pages and offsets unchanged", () => {
  assert.deepEqual(staffCustomerDirectoryPagination("3", 120), {
    page: 3, totalPages: 3, total: 120, limit: 50, offset: 100, truncated: false,
  });
  assert.deepEqual(staffCustomerDirectoryPagination("999", 120), {
    page: 3, totalPages: 3, total: 120, limit: 50, offset: 100, truncated: false,
  });
});

test("customer directory caps unfiltered deep offsets at 100,000 matching rows", () => {
  const page = staffCustomerDirectoryPagination("999999", 150_000);
  assert.equal(CUSTOMER_DIRECTORY_MAX_PAGES, 2_000);
  assert.equal(page.page, 2_000);
  assert.equal(page.totalPages, 2_000);
  assert.equal(page.offset, 99_950);
  assert.equal(page.truncated, true);
});
