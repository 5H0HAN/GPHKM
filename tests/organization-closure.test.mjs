import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("staff organization-closure history is role-gated and paginated", async () => {
  const service = await readFile(new URL("../src/server/identity/organization-closure.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/app/staff/(console)/support/page.tsx", import.meta.url), "utf8");
  const migration = await readFile(new URL("../src/db/migrations/0102_organization_closure_page_index.sql", import.meta.url), "utf8");
  assert.match(service, /requireStaffAccess\(headers, "organization\.closure\.manage"\)/);
  assert.match(service, /staffCatalogPagination\(requestedPage, count\?\.total \?\? 0\)/);
  assert.match(service, /orderBy\(desc\(organizationClosureRequest\.updatedAt\), desc\(organizationClosureRequest\.id\)\)/);
  assert.match(page, /actorRole === "ADMIN" \|\| actorRole === "SUPER_ADMIN"/);
  assert.match(page, /Organization closure request pages/);
  assert.match(migration, /organization_closure_request_updated_page_idx/);
});

test("closure finalization still locks and rejects unresolved financial or order blockers", async () => {
  const service = await readFile(new URL("../src/server/identity/organization-closure.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../src/db/migrations/0065_organization_closure_support.sql", import.meta.url), "utf8");
  assert.match(service, /for update/);
  assert.match(service, /gphkm_closure_blockers/);
  assert.match(migration, /WALLET_BALANCE/);
  assert.match(migration, /ACTIVE_ORDERS/);
  assert.match(migration, /OPEN_STRIPE_CASES/);
  assert.match(migration, /OPEN_SUPPORT_CASES/);
  assert.match(migration, /UNRESOLVED_PAYMENTS/);
});
