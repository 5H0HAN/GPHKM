import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allowedSupportTransitions, assertSupportTransition, customerSupportProjection, customerSupportStatus, financeOutcome, supportText } from "../src/modules/support/cases.ts";
import { decodeSupportEventCursor, encodeSupportEventCursor } from "../src/modules/support/event-cursor.ts";

test("Support messages are bounded text and cannot smuggle control characters", () => {
  assert.equal(supportText("  Please check this placement.\nThank you.  "), "Please check this placement.\nThank you.");
  for (const value of ["", "   ", "bad\0text", "bad\u0007text", { attachment: "file" }, "x".repeat(4001)]) {
    assert.throws(() => supportText(value));
  }
  assert.throws(() => supportText("x".repeat(2001), 2000));
});

test("customer Support projection excludes internal state, actors, notes and Finance decisions", () => {
  const at = new Date("2026-10-28T12:00:00Z");
  const row = { id: "case", orderId: "order", orderItemId: "item", summary: "Where is my placement?", state: "FINANCE_REVIEW", createdAt: at, updatedAt: at, openedByUserId: "private-user", organizationId: "private-org" };
  const events = [
    { id: "reply", audience: "CUSTOMER", kind: "REPLY", actorKind: "STAFF", body: "We are reviewing your request.", createdAt: at, actorUserId: "private-staff" },
    { id: "private-note", audience: "INTERNAL", kind: "NOTE", actorKind: "STAFF", body: "supplier@example.test", createdAt: at },
    { id: "decision", audience: "FINANCE", kind: "FINANCE_DECISION", actorKind: "STAFF", body: "Private decision", createdAt: at },
    { id: "fake-state", audience: "CUSTOMER", kind: "STATE_CHANGED", actorKind: "STAFF", body: "FINANCE_REVIEW", createdAt: at },
  ];
  const projected = customerSupportProjection(row, events);
  assert.equal(projected.status, "In review");
  assert.deepEqual(projected.messages, [{ id: "reply", from: "GPHKM", body: "We are reviewing your request.", at: at.toISOString() }]);
  const serialized = JSON.stringify(projected);
  for (const secret of ["private-user", "private-org", "private-staff", "supplier@", "Private decision", "FINANCE_REVIEW"]) assert.equal(serialized.includes(secret), false);
  assert.equal(customerSupportStatus("WAITING_ON_SUPPLIER"), "In review");
  assert.equal(customerSupportStatus("WAITING_ON_CUSTOMER"), "Waiting on you");
});

test("ordinary transitions cannot bypass Finance review and no refund approval exists", () => {
  assert.doesNotThrow(() => assertSupportTransition("OPEN", "FINANCE_REVIEW", "ADMIN"));
  assert.throws(() => assertSupportTransition("OPEN", "RESOLVED", "FINANCE"), /Forbidden/);
  for (const role of ["ADMIN", "FINANCE", "SUPER_ADMIN"]) {
    assert.throws(() => assertSupportTransition("FINANCE_REVIEW", "RESOLVED", role));
    assert.throws(() => assertSupportTransition("CLOSED", "INVESTIGATING", role));
  }
  assert.deepEqual(allowedSupportTransitions("CLOSED"), []);
  assert.equal(financeOutcome("DENIED"), "DENIED");
  assert.equal(financeOutcome("MORE_INFORMATION_REQUIRED"), "MORE_INFORMATION_REQUIRED");
  assert.throws(() => financeOutcome("APPROVED"), /Refund execution is not available/);
});

test("Support migration protects history and scopes customer, assignment, and Finance visibility", () => {
  const sql = readFileSync(new URL("../src/db/migrations/0011_support_cases.sql", import.meta.url), "utf8");
  assert.match(sql, /ALTER TABLE support_case ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE support_case_event ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /public\.gphkm_is_active_org_member\(c\.organization_id, target_user\)/);
  assert.match(sql, /c\.opened_by_user_id = target_user OR o\.actor_user_id = target_user/);
  assert.match(sql, /f\.assigned_admin_id = target_user/);
  assert.match(sql, /c\.state = 'FINANCE_REVIEW'/);
  assert.match(sql, /audience = 'CUSTOMER' AND kind = 'REPLY'/);
  assert.match(sql, /audience IN \('CUSTOMER','INTERNAL'\)/);
  assert.match(sql, /audience IN \('CUSTOMER','FINANCE'\)/);
  assert.match(sql, /REVOKE UPDATE, DELETE ON support_case_event FROM gphkm_runtime/);
  assert.match(sql, /support history is append-only/);
  assert.match(sql, /support case identity and opening are immutable/);
  assert.match(sql, /support order\/item mismatch/);
  assert.doesNotMatch(sql, /INSERT INTO (public\.)?wallet_ledger_entry|UPDATE (public\.)?wallet_account/);
});

test("customer and staff Support case queues paginate inside their existing scopes", () => {
  const source = readFileSync(new URL("../src/server/support/cases.ts", import.meta.url), "utf8");
  const customerPage = readFileSync(new URL("../src/app/customer/support/page.tsx", import.meta.url), "utf8");
  const staffPage = readFileSync(new URL("../src/app/staff/(console)/support/page.tsx", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../src/db/migrations/0098_support_case_pagination_indexes.sql", import.meta.url), "utf8");
  assert.match(source, /gphkm_support_customer_access\(\$\{supportCase\.id\}, \$\{actor\.userId\}, \$\{organizationId\}\)/);
  assert.match(source, /staffCatalogPagination\(requestedPage, count\?\.total \?\? 0\)/);
  assert.match(source, /desc\(supportCase\.updatedAt\), desc\(supportCase\.id\)/);
  assert.match(customerPage, /Support request pages/);
  assert.match(staffPage, /Support case pages/);
  assert.match(migration, /support_case_updated_cursor_idx/);
});

test("long Support histories use validated stable cursors without crossing customer audience filters", () => {
  const createdAt = new Date("2026-10-29T12:34:56.789Z");
  const cursor = { createdAt, id: "123e4567-e89b-42d3-a456-426614174000" };
  assert.deepEqual(decodeSupportEventCursor(encodeSupportEventCursor(cursor)), cursor);
  for (const value of [undefined, "x", "%%%", Buffer.from("not-a-cursor").toString("base64url"), Buffer.from(`${createdAt.toISOString()}\nnot-uuid`).toString("base64url")]) {
    assert.equal(decodeSupportEventCursor(value), null);
  }
  const source = readFileSync(new URL("../src/server/support/cases.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../src/db/migrations/0099_support_event_pagination_index.sql", import.meta.url), "utf8");
  assert.match(source, /eq\(supportCaseEvent\.audience, "CUSTOMER"\)/);
  assert.match(source, /\.limit\(51\)/);
  assert.match(source, /desc\(supportCaseEvent\.createdAt\), desc\(supportCaseEvent\.id\)/);
  assert.match(migration, /support_case_event_history_idx\s+ON public\.support_case_event\(case_id, created_at, id\)/);
});
