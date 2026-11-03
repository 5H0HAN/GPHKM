import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allowedSupportTransitions, assertSupportTransition, customerCanReplyToSupportCase, customerSupportProjection, customerSupportStatus, financeOutcome, supportQueueFilter, supportText } from "../src/modules/support/cases.ts";
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

test("customer replies reopen waiting cases but terminal cases require a new request", () => {
  assert.equal(customerCanReplyToSupportCase("WAITING_ON_CUSTOMER"), true);
  assert.equal(customerCanReplyToSupportCase("INVESTIGATING"), true);
  assert.equal(customerCanReplyToSupportCase("RESOLVED"), false);
  assert.equal(customerCanReplyToSupportCase("CLOSED"), false);
  assert.equal(supportQueueFilter("ACTIVE"), "ACTIVE");
  assert.equal(supportQueueFilter("WAITING_ON_CUSTOMER"), "WAITING_ON_CUSTOMER");
  assert.equal(supportQueueFilter("not-a-state"), "ACTIVE");

  const source = readFileSync(new URL("../src/server/support/cases.ts", import.meta.url), "utf8");
  const reply = source.split("export async function replyToCustomerSupportCase")[1].split("export async function listStaffSupportCases")[0];
  assert.match(reply, /lockedCase\(tx, input\.caseId\)/);
  assert.match(reply, /hasPriorHistory\(tx, event\)[\s\S]*customerCanReplyToSupportCase\(row\.state\)/,
    "a committed reply replay must succeed before terminal-state rejection");
  assert.match(reply, /SUPPORT_STATE_CHANGED", "INVESTIGATING"/);
  assert.match(source, /public\.gphkm_support_customer_access\(\$\{supportCase\.id\}, \$\{actor\.userId\}, \$\{organizationId\}\)/,
    "dashboard summary and customer case listing must stay scoped to opened/order-linked cases");
  assert.match(source, /groupBy\(supportCase\.state\)[\s\S]*\.limit\(boundedLimit\)/,
    "the customer summary counts the full scoped set and bounds only the recent rows");
});

test("staff case state command compares exact replays before its stale-state check", () => {
  const source = readFileSync(new URL("../src/server/support/cases.ts", import.meta.url), "utf8");
  const change = source.split("export async function changeSupportState")[1].split("export async function recordSupportFinanceDecision")[0];
  assert.match(change, /lockedCase\(tx, input\.caseId\)/);
  assert.match(change, /hasPriorHistory\(tx, event\)\) return \{ state: row\.state \};[\s\S]*row\.state !== from/,
    "an exact replay is accepted even after the case advanced");
  assert.match(change, /assertSupportTransition\(from, to, actor\.role\)/);
  assert.match(change, /to === "RESOLVED" \|\| to === "CLOSED"[\s\S]*gphkm_supplier_failure_case_can_close/,
    "the service explains why a supplier-failure case cannot be terminal while recovery is unresolved");
  assert.match(change, /customer-approved supplier alternative or cancel\/refund the placement/);
  assert.match(source, /if \(prior\.requestHash !== requestHash\) throw new Error\("Support action idempotency conflict"\)/,
    "the same key with a different payload remains rejected");
});

test("supplier-failure Support closure is serialized with accepted equivalent routing", () => {
  const migration = readFileSync(new URL("../src/db/migrations/0163_order_scoped_support.sql", import.meta.url), "utf8");
  assert.match(migration, /gphkm_supplier_failure_case_can_close[\s\S]*last_equivalent_offer_id[\s\S]*route_generation = current_route\.route_generation/);
  const closeGuard = migration.split("CREATE OR REPLACE FUNCTION public.gphkm_guard_supplier_failure_case_close")[1].split("$$;")[0];
  assert.match(closeGuard, /FOR UPDATE[\s\S]*FOR KEY SHARE[\s\S]*gphkm_supplier_failure_case_can_close/,
    "case closure locks the case, then sorted items and routes, and rechecks after it waits for concurrent acceptance");
  assert.match(migration, /every failed item has an accepted current route or is canceled\/refunded/);
  assert.match(migration, /latest\.actor_user_id = ord\.actor_user_id/,
    "only the ordering member's acceptance can resolve a failed placement, even if another Owner opened the case");
});

test("equivalent route consent belongs to the order actor, not whoever opened Support", () => {
  const migration = readFileSync(new URL("../src/db/migrations/0163_order_scoped_support.sql", import.meta.url), "utf8");
  const binding = migration.split("CREATE OR REPLACE FUNCTION public.gphkm_validate_content_change_event_binding")[1].split("$$;")[0];
  assert.match(binding, /ord\.actor_user_id = NEW\.actor_user_id/);
  assert.doesNotMatch(binding, /c\.opened_by_user_id = NEW\.actor_user_id/);
  const acceptance = migration.split("CREATE OR REPLACE FUNCTION public.gphkm_apply_equivalent_offer_acceptance")[1].split("$$;")[0];
  assert.doesNotMatch(acceptance, /handed_off_at\s*=\s*NULL|work_started_at\s*=\s*NULL/,
    "rerouting must preserve the original cancellation cutoff timestamps");
  const race = readFileSync(new URL("../scripts/check-content-handoff-race-local.ts", import.meta.url), "utf8");
  assert.match(race, /Consent race fixture case owner/);
  assert.match(race, /routeSupportCaseId, organizationId, orderId, routeItemId, caseOwnerId/,
    "the local race fixture opens the shared case as an Owner distinct from the ordering member");
  assert.match(race, /originalCutoffs[\s\S]*retains the original post-handoff cancellation cutoff/);
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

test("customer case opening serializes the scoped idempotency key before a plain RLS insert", () => {
  const source = readFileSync(new URL("../src/server/support/cases.ts", import.meta.url), "utf8");
  const open = source.split("export async function openCustomerSupportCase")[1].split("export async function listCustomerSupportCases")[0];
  assert.match(open, /pg_advisory_xact_lock\(hashtextextended\([\s\S]*gphkm:support-open:/);
  assert.match(open, /eq\(supportCase\.idempotencyKey, input\.idempotencyKey\)/);
  assert.match(open, /await tx\.insert\(supportCase\)[\s\S]*?\);/);
  assert.doesNotMatch(open, /onConflictDoNothing|\.returning\(\)/);
});

test("content consent serializes with handoff inside a privileged database trigger", () => {
  const source = readFileSync(new URL("../src/server/orders/content-changes.ts", import.meta.url), "utf8");
  const consent = source.split("export async function consentToContentChange")[1].split("export async function listContentChangesForCustomer")[0];
  assert.doesNotMatch(consent, /\.for\("update"\)/);
  const migration = readFileSync(new URL("../src/db/migrations/0134_content_consent_serialization.sql", import.meta.url), "utf8");
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /FROM public\.order_item_fulfillment f[\s\S]*FOR UPDATE/);
  assert.match(migration, /gphkm_change_request_before_handoff\(request_item\)/);
});

test("customer and staff Support case queues paginate inside their existing scopes", () => {
  const source = readFileSync(new URL("../src/server/support/cases.ts", import.meta.url), "utf8");
  const customerPage = readFileSync(new URL("../src/app/customer/support/page.tsx", import.meta.url), "utf8");
  const staffPage = readFileSync(new URL("../src/app/staff/(console)/support/page.tsx", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../src/db/migrations/0098_support_case_pagination_indexes.sql", import.meta.url), "utf8");
  const itemScopeMigration = readFileSync(new URL("../src/db/migrations/0166_scope_staff_order_item_rows.sql", import.meta.url), "utf8");
  assert.match(source, /gphkm_support_customer_access\(\$\{supportCase\.id\}, \$\{actor\.userId\}, \$\{organizationId\}\)/);
  assert.match(source, /staffCatalogPagination\(requestedPage, count\?\.total \?\? 0\)/);
  assert.match(source, /itemCount:[\s\S]*gphkm_support_case_placement_count/,
    "the queue uses a scoped count projection so staff item RLS does not hide sibling placement totals");
  assert.match(source, /desc\(supportCase\.updatedAt\), desc\(supportCase\.id\)/);
  assert.match(itemScopeMigration, /DROP POLICY customer_order_item_read[\s\S]*NOT public\.gphkm_is_active_staff[\s\S]*gphkm_customer_can_read_order_item/);
  assert.match(itemScopeMigration, /gphkm_support_admin_access[\s\S]*gphkm_support_customer_access/);
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

test("support reply migration resumes waiting cases under RLS and blocks terminal customer replies", () => {
  const migration = readFileSync(new URL("../src/db/migrations/0157_support_customer_reply_state.sql", import.meta.url), "utf8");
  const policyMigration = readFileSync(new URL("../src/db/migrations/0158_restrict_customer_support_state_event.sql", import.meta.url), "utf8");
  const customerPage = readFileSync(new URL("../src/app/customer/support/[caseId]/page.tsx", import.meta.url), "utf8");
  const staffPage = readFileSync(new URL("../src/app/staff/(console)/support/page.tsx", import.meta.url), "utf8");
  assert.match(policyMigration, /support_event_customer_insert[\s\S]*kind = 'REPLY'[\s\S]*kind = 'OPENED'/);
  assert.doesNotMatch(policyMigration.split("CREATE POLICY support_event_customer_insert")[1], /kind = 'STATE_CHANGED'/,
    "customers cannot directly append state-change events to reopen a case");
  assert.match(migration, /actor_kind = 'CUSTOMER'[\s\S]*from_state = 'WAITING_ON_CUSTOMER'[\s\S]*to_state = 'INVESTIGATING'/);
  assert.match(migration, /case_row\.state = 'RESOLVED'[\s\S]*gphkm_support_customer_access/);
  assert.match(migration, /AFTER INSERT ON support_case_event[\s\S]*gphkm_support_customer_reply_resume/);
  assert.match(migration, /SELECT \* INTO case_row FROM public\.support_case WHERE id = NEW\.case_id FOR UPDATE/);
  assert.match(migration, /UPDATE public\.support_case SET state = 'INVESTIGATING'/);
  assert.match(customerPage, /item\.canReply[\s\S]*This request is resolved and closed[\s\S]*Open a new request/);
  assert.match(staffPage, /ACTIVE: "Active work"/);
  assert.match(staffPage, /Case queue/);
  assert.match(staffPage, /Order #/);
  assert.match(staffPage, /listStaffSupportCases\(await headers\(\), requestedPage, requestedFilter\)/);
});
