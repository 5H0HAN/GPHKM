import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { MAX_WORKSPACE_ACCESS_ORGANIZATIONS, workspaceMarketplaceAccessQuery } from "../src/db/workspace-marketplace-access.ts";

test("workspace access compiles to one bounded, parameterized membership projection", () => {
  const ids = Array.from({ length: MAX_WORKSPACE_ACCESS_ORGANIZATIONS + 1 }, (_, index) => `organization-${index}`);
  const dialect = new PgDialect();
  const one = dialect.sqlToQuery(workspaceMarketplaceAccessQuery(ids.slice(0, 1)));
  const many = dialect.sqlToQuery(workspaceMarketplaceAccessQuery(ids));
  assert.equal(one.sql, many.sql, "workspace size does not add queries or bind positions");
  assert.ok(many.params.every((param) => Array.isArray(param) && param.length === MAX_WORKSPACE_ACCESS_ORGANIZATIONS));
  assert.equal(many.params[0].includes(ids.at(-1)), false);
  assert.match(many.sql, /member\.user_id = nullif\(current_setting\('app\.user_id', true\), ''\)/);
  assert.match(many.sql, /member\.active and org\.id = any/);
  assert.match(many.sql, /gphkm_customer_has_marketplace_access\(\s*set_config\('app\.organization_id', org\.id, true\)/);
});

test("the customer layout makes one workspace-access read", async () => {
  const layout = await readFile(new URL("../src/app/customer/layout.tsx", import.meta.url), "utf8");
  const server = await readFile(new URL("../src/server/wallet/read.ts", import.meta.url), "utf8");
  const body = server.split("export async function listWorkspaceMarketplaceAccess")[1].split("export async function requireMarketplaceAccess")[0];
  assert.equal([...layout.matchAll(/await listWorkspaceMarketplaceAccess\(/g)].length, 1);
  assert.doesNotMatch(layout, /getMarketplaceAccess|Promise\.all/);
  assert.equal([...body.matchAll(/workspaceMarketplaceAccessQuery\(/g)].length, 1);
  assert.equal([...body.matchAll(/await requireVerifiedCustomer\(/g)].length, 1);
});
