import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("payout reconciliation is Finance-gated, read-only against Stripe, allowlisted, and audited", () => {
  const service = source("src/server/wallet/payout-reconciliation.ts");
  assert.match(service, /requireStaffAccess\(headers, "wallet\.reconcile"\)/);
  assert.match(service, /client\.payouts\.retrieve\(payoutId, \{ expand: \["balance_transaction"\] \}\)/);
  assert.match(service, /client\.balanceTransactions\.list\(\{ payout: payout\.id/);
  assert.match(service, /gphkm_store_stripe_payout_snapshot/);
  assert.match(service, /gphkm_record_stripe_payout_bank_review/);
  assert.doesNotMatch(service, /payouts\.create|payout\.destination|failure_message|payment_method_details/);

  const sql = source("src/db/migrations/0074_stripe_payout_settlement_reconciliation.sql");
  assert.match(sql, /stripe_payout_snapshot_immutable/);
  assert.match(sql, /stripe_payout_bank_review_immutable/);
  assert.match(sql, /transactions_net <> payout_amount/);
  assert.match(sql, /Paid Stripe payout has no matching payout balance transaction/);
  assert.match(sql, /Payout cannot be matched to the submitted bank evidence/);
  assert.match(sql, /STRIPE_PAYOUT_BANK_REVIEWED/);

  const roleMigration = source("src/db/migrations/0075_super_admin_permission_inheritance.sql");
  assert.match(roleMigration, /s\.role = required_role OR s\.role = 'SUPER_ADMIN'/);
  assert.match(source("src/app/staff/(console)/reconciliation/page.tsx"), /A staff review is an attestation/);
});
