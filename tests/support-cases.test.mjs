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

test("supplier failures are bound to the failed route generation and declines keep items held", async () => {
  const migration = readFileSync(new URL("../src/db/migrations/0168_supplier_failure_route_generation.sql", import.meta.url), "utf8");
  assert.match(migration, /UPDATE public\.supplier_fulfillment_outcome outcome[\s\S]*WHEN outcome\.supplier_id = current_route\.supplier_id THEN current_route\.route_generation[\s\S]*current_route\.route_generation IN \(1, 2\)[\s\S]*outcome\.supplier_id = financial\.fulfillment_supplier_id THEN 1/,
    "legacy outcomes are assigned only a source generation proven by the checkout supplier and accepted route count, including 0162's generation-1 legacy shape");
  assert.doesNotMatch(migration, /event\.created_at\s*<=\s*outcome\.created_at/,
    "outcome source generations are not inferred from app-supplied timestamps");
  assert.match(migration, /current_route\.last_equivalent_offer_id[\s\S]*outcome\.supplier_id IS DISTINCT FROM current_route\.supplier_id[\s\S]*outcome\.supplier_id = financial\.fulfillment_supplier_id[\s\S]*current_route\.route_generation IN \(1, 2\)[\s\S]*outcome\.route_generation = 1/,
    "legacy resolutions are backfilled only from the sole accepted current route and the immutable checkout supplier");
  assert.match(migration, /migration blocked:[\s\S]*historical supplier failure/,
    "ambiguous terminal history blocks deployment instead of silently unlocking or stranding it");
  assert.match(migration, /LEFT JOIN public\.order_item_fulfillment fulfillment[\s\S]*fulfillment\.order_item_id IS NULL[\s\S]*fulfillment\.state = 'COMPLETED'[\s\S]*accepted_counts\.accepted_count > 1/,
    "ambiguous A-to-B-to-A history, missing fulfillment rows, and completed unresolved items stop for reconciliation");
  assert.match(migration, /current_route\.route_generation = 1 AND accepted_counts\.accepted_count = 1[\s\S]*current_route\.last_equivalent_offer_id[\s\S]*legacy_route\.route_generation = 1/,
    "generation-1 legacy acceptance is admitted only when 0162's current-offer pointer proves it");
  assert.match(migration, /gphkm_snapshot_supplier_failure_route[\s\S]*NEW\.route_generation := current_generation/);
  assert.match(migration, /GRANT SELECT ON public\.supplier_fulfillment_outcome_resolution TO gphkm_runtime[\s\S]*CREATE POLICY supplier_failure_resolution_assigned_read[\s\S]*gphkm_staff_can_read_order_item/,
    "the packet service can check explicit resolution edges without exposing them beyond assigned staff RLS");
  const failureSnapshot = migration.split("CREATE OR REPLACE FUNCTION public.gphkm_snapshot_supplier_failure_route")[1].split("$$;")[0];
  assert.ok(failureSnapshot.indexOf("order_item_fulfillment fulfillment") < failureSnapshot.indexOf("support_case case_row"),
    "direct supplier-failure inserts acquire item locks before the Support case lock");
  assert.match(migration, /gphkm_require_current_supplier_failure_for_offer_event[\s\S]*outcome\.route_generation = current_generation/,
    "new replacement offers must target a failure on the current source generation");
  assert.match(migration, /gphkm_resolve_supplier_failures_after_route_acceptance[\s\S]*outcome\.route_generation = OLD\.route_generation/,
    "an accepted route records immutable resolution edges for all failures on that exact source generation");
  assert.match(migration, /gphkm_lock_active_supplier_failure_case_for_offer_event[\s\S]*FOR SHARE/,
    "offer events serialize against case closure with a compatible case-row lock");
  const closeGuard = migration.split("CREATE OR REPLACE FUNCTION public.gphkm_guard_supplier_failure_case_close")[1].split("$$;")[0];
  assert.doesNotMatch(closeGuard, /order_item_fulfillment[\s\S]*FOR UPDATE/,
    "case closure does not take the case-then-item lock order that deadlocks customer acceptance");
  const close = migration.split("CREATE OR REPLACE FUNCTION public.gphkm_supplier_failure_case_can_close")[1].split("$$;")[0];
  assert.match(close, /supplier_fulfillment_outcome_resolution[\s\S]*resolution\.outcome_id = outcome\.id/,
    "case closure checks an explicit accepted-offer resolution per failed item");
  const gate = migration.split("CREATE OR REPLACE FUNCTION public.gphkm_gate_unresolved_supplier_failure")[1].split("$$;")[0];
  assert.match(gate, /supplier_fulfillment_outcome_resolution[\s\S]*resolution\.outcome_id = outcome\.id/);
  assert.doesNotMatch(gate, /DECLINED|state_before_hold/,
    "declined offers do not bypass the supplier-failure hold");
  const packetGuard = migration.split("CREATE OR REPLACE FUNCTION public.gphkm_packet_attempt_supplier_failure_resolution_guard")[1].split("$$;")[0];
  assert.match(packetGuard, /supplier_fulfillment_outcome_resolution[\s\S]*resolution\.outcome_id = outcome\.id/,
    "packet attempts also require every failure to have an accepted-offer resolution");

  const service = readFileSync(new URL("../src/server/fulfillment/equivalent-offers.ts", import.meta.url), "utf8");
  const decline = service.split('if (input.decision === "DECLINE")')[1]
    .split('await appendAuditEvent(tx, { organizationId, actorUserId: actor.userId, action: "SUPPLIER_EQUIVALENT_OFFER_DECLINED"')[0];
  assert.doesNotMatch(decline, /stateBeforeHold|state: fulfillment\.state|orderItemFulfillment/,
    "decline records the decision without restoring the failed supplier's prior fulfillment state");
  const failureService = readFileSync(new URL("../src/server/fulfillment/supplier-outcomes.ts", import.meta.url), "utf8");
  assert.ok(failureService.indexOf(".from(orderItemFulfillment)") < failureService.indexOf(".from(supportCase)"),
    "staff failure recording locks the item before the active Support case, matching equivalent-offer decisions");

  const race = readFileSync(new URL("../scripts/check-content-handoff-race-local.ts", import.meta.url), "utf8");
  assert.match(race, /generation-2 failure is not resolved by the earlier generation-2 acceptance/);
  assert.match(race, /sibling_item_decline_hold_release/,
    "the local database regression covers a decline on one placement attempting to release a sibling placement");
  assert.match(race, /Supplier failure waits for a concurrent customer offer event/,
    "the local two-session regression covers supplier-failure recording while a customer decides an offer");
  assert.match(race, /Synthetic later supplier failure[\s\S]*routeMismatchCaseId/,
    "the race fixture opens a new order conversation after the previous case resolves");
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
  assert.match(open, /const normalizedOrderId = input\.orderId \? identity\(input\.orderId\) : null/);
  assert.match(open, /const normalizedOrderItemId = input\.orderItemId \? identity\(input\.orderItemId\) : null/);
  assert.match(open, /requestHash = digest\(\{ orderId: normalizedOrderId, orderItemId: normalizedOrderItemId/);
  assert.match(open, /priorMessage\.orderId !== normalizedOrderId/);
  assert.match(open, /let requestedOrderId = normalizedOrderId;\s*let contextItemId = normalizedOrderItemId/,
    "the General Support empty selection stays null through replay checks and insertion");
  assert.match(open, /pg_advisory_xact_lock\(hashtextextended\([\s\S]*gphkm:support-open:/);
  assert.match(open, /eq\(supportCase\.idempotencyKey, input\.idempotencyKey\)/);
  assert.match(open, /await tx\.insert\(supportCase\)[\s\S]*?\);/);
  assert.doesNotMatch(open, /onConflictDoNothing|\.returning\(\)/);
});

test("order Support intake rechecks the case after acquiring the staff resolution lock", () => {
  const source = readFileSync(new URL("../src/server/support/cases.ts", import.meta.url), "utf8");
  const open = source.split("export async function openCustomerSupportCase")[1].split("export async function listCustomerSupportCases")[0];
  assert.match(open, /gphkm:support-order:[\s\S]*const active = await lockedCase\(tx, candidate.id\)/);
  assert.match(open, /if \(customerCanReplyToSupportCase\(active.state\)\) \{[\s\S]*await appendHistory\(tx, message\)/);
  assert.match(open, /return \{ caseId: active.id, reused: true \};\s*\}\s*\}[\s\S]*await tx.insert\(supportCase\)/);
});

test("supplier notices remain readable to authorized staff after a Support case closes", () => {
  const migration = readFileSync(new URL("../src/db/migrations/0169_support_history_and_review_fixes.sql", import.meta.url), "utf8");
  const policy = migration.split("CREATE POLICY supplier_item_notice_staff_read")[1].split(");")[0];
  assert.match(policy, /gphkm_supplier_packet_access/);
  assert.match(policy, /f\.assigned_admin_id = nullif\(current_setting\('app\.user_id',true\),''\)[\s\S]*gphkm_is_active_staff/);
  assert.match(policy, /c\.id = case_id[\s\S]*i\.id = supplier_item_notice\.order_item_id/);
  assert.doesNotMatch(policy, /c\.state\s+NOT IN/,
    "terminal and merged conversations keep historical notice evidence visible within packet and staff scope");
});

test("content consent serializes with handoff inside a privileged database trigger", () => {
  const source = readFileSync(new URL("../src/server/orders/content-changes.ts", import.meta.url), "utf8");
  const consent = source.split("export async function consentToContentChange")[1].split("export async function listContentChangesForCustomer")[0];
  assert.doesNotMatch(consent, /\.for\("update"\)/);
  assert.match(consent, /const recipientReconsent = request\.purpose === "RECIPIENT_RECONSENT";\s*if \(recipientReconsent\) \{[\s\S]*?gphkm_lock_customer_recipient_reconsent/,
    "recipient route locking is limited to the purpose the database helper authorizes");
  assert.match(consent, /fulfillment\.handedOffAt \|\| \["IN_FULFILLMENT"/,
    "ordinary content consent remains protected by the consent-event handoff guard");
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
  const createdAt = "2026-10-29T12:34:56.789123Z";
  const cursor = { createdAt, id: "123e4567-e89b-42d3-a456-426614174000" };
  assert.deepEqual(decodeSupportEventCursor(encodeSupportEventCursor(cursor)), cursor);
  for (const value of [undefined, "x", "%%%", Buffer.from("not-a-cursor").toString("base64url"), Buffer.from(`${createdAt}\nnot-uuid`).toString("base64url")]) {
    assert.equal(decodeSupportEventCursor(value), null);
  }
  const source = readFileSync(new URL("../src/server/support/cases.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../src/db/migrations/0099_support_event_pagination_index.sql", import.meta.url), "utf8");
  assert.match(source, /eq\(supportCaseEvent\.audience, "CUSTOMER"\)/);
  assert.match(source, /\.limit\(51\)/);
  assert.equal(source.match(/createdAt: last.cursorTime/g)?.length, 2);
  assert.match(source, /HH24:MI:SS.US/);
  assert.match(source, /cursor.createdAt\}::timestamptz/);
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
