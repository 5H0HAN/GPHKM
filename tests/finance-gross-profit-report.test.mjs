import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Finance gross-profit report has a narrow, paginated projection and costs.read guard", async () => {
  const service = await read("../src/server/catalog/gross-profit-report.ts");
  const migration = await read("../src/db/migrations/0119_finance_gross_profit_report.sql");
  const correctiveMigration = await read("../src/db/migrations/0120_fix_finance_gross_profit_page_alias.sql");
  const page = await read("../src/app/staff/(console)/suppliers/finance/margins/page.tsx");
  const navigation = await read("../src/app/staff/(console)/layout.tsx");

  assert.match(service, /requireStaffAccess\(headers, "costs\.read"\)/);
  assert.match(service, /staffCatalogPagination\(requestedPage, 5_000_000\)/);
  assert.match(service, /set_config\('app\.user_id'/);
  assert.match(service, /FINANCE_GROSS_PROFIT_REPORT_VIEWED/);
  assert.match(service, /gphkm_finance_gross_profit_report/);
  assert.match(migration, /SECURITY DEFINER SET search_path = pg_catalog, public/);
  assert.match(migration, /gphkm_is_active_staff\(actor_id, 'FINANCE'\)/);
  assert.match(migration, /gphkm_is_active_staff\(actor_id, 'SUPER_ADMIN'\)/);
  assert.match(migration, /customer_order\.created_at >= now\(\) - interval '90 days'/);
  assert.match(migration, /gphkm_finance_item_suppliers/);
  assert.match(migration, /ORDER BY event\.created_at DESC, event\.id DESC/);
  assert.match(migration, /WHEN costs_and_sales\.costs_confirmed THEN/);
  assert.match(migration, /ELSE NULL END/);
  assert.match(migration, /LIMIT 50/);
  assert.match(migration, /item\.placement_price_minor \+ item\.writing_price_minor/);
  assert.match(migration, /ledger\.kind = 'ITEM_REFUND'/);
  assert.doesNotMatch(migration, /customer_email|customer_name|article_text|writing_brief|target_url|anchor_text|payment_payload|supplier_contact/i);
  assert.match(correctiveMigration, /AS selected_page/);
  assert.match(correctiveMigration, /SELECT page_bounds\.selected_page FROM page_bounds/);
  assert.match(page, /Gross profit equals retail charges minus recorded item refunds and confirmed direct placement and writing costs/);
  assert.match(page, /Stripe processing fees are excluded here and reconciled separately in Finance/);
  assert.match(page, /item\.costStatus === "UNKNOWN" \? "Unavailable" : "Provisional"/);
  assert.match(navigation, /Gross profit.*permission: "costs\.read"/);
  assert.doesNotMatch(page, /supplierContact|websiteUrl|articleText|writingBrief|targetUrl|payment_payload/i);
});
