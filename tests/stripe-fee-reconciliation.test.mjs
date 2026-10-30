import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Finance Stripe snapshots retain charge fees and fail closed on missing or mismatched captured balance facts", () => {
  const finance = source("src/server/wallet/finance-reconciliation.ts");
  assert.match(finance, /expand: \["latest_charge\.balance_transaction"\]/);
  assert.match(finance, /chargeBalanceTransaction: normalizedChargeBalanceTransaction/);
  assert.match(finance, /intent\.amount_received > 0 && \(!normalizedChargeBalanceTransaction/);
  assert.match(finance, /normalizedChargeBalanceTransaction\.currency !== intent\.currency\.toLowerCase\(\)/);
  assert.match(finance, /Number\(normalizedChargeBalanceTransaction\.amountMinor\) !== intent\.amount_received/);
  assert.match(finance, /feeMinor: String\(value\.fee\)/);
  assert.doesNotMatch(finance, /payment_method_details|billing_details|customer_email/);

  const migration = source("src/db/migrations/0073_stripe_charge_fee_completeness.sql");
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.gphkm_validate_stripe_finance_snapshot/);
  assert.match(migration, /charge_facts->>'amountMinor'\)\:\:numeric <> received/);
  assert.match(migration, /charge_facts->>'netMinor'\)\:\:numeric <>/);
  assert.match(migration, /NEW\.complete THEN[\s\S]*chargeBalanceTransaction/);

  const view = source("src/app/staff/(console)/reconciliation/page.tsx");
  assert.match(view, /processing-fee balance transaction unavailable/);
  assert.match(view, /Stripe payouts to bank settlement records/);
});
