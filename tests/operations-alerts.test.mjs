import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boundedQueueCount, canApplyOperationsRefresh, hasActionableOperations, normalizeOperationTimestamp, operationsCountLabel, shouldRefreshOperationsInbox, staffSupportAttentionStates, supportNextAction } from "../src/modules/observability/operations-inbox.ts";
import { operationsWorkItemVersion } from "../src/server/observability/attention-version.ts";
import { hasStaffPermission } from "../src/server/identity/policy.ts";

test("overview Support states stay within each staff role's workflow scope", () => {
  assert.deepEqual(staffSupportAttentionStates("ADMIN"), ["OPEN", "INVESTIGATING", "WAITING_ON_SUPPLIER"]);
  assert.deepEqual(staffSupportAttentionStates("FINANCE"), ["FINANCE_REVIEW"]);
  assert.deepEqual(staffSupportAttentionStates("SUPER_ADMIN"), ["OPEN", "INVESTIGATING", "WAITING_ON_SUPPLIER", "FINANCE_REVIEW"]);
  assert.equal(supportNextAction("WAITING_ON_SUPPLIER"), "Check supplier response");
  assert.equal(supportNextAction("FINANCE_REVIEW"), "Review financial decision");
});

test("added queue visibility follows the project's permission matrix", () => {
  for (const role of ["ADMIN", "SUPER_ADMIN"]) {
    assert.equal(hasStaffPermission(role, "refund.pre-handoff.approve"), true);
    assert.equal(hasStaffPermission(role, "organization.closure.manage"), true);
  }
  assert.equal(hasStaffPermission("FINANCE", "refund.pre-handoff.approve"), false);
  assert.equal(hasStaffPermission("FINANCE", "organization.closure.manage"), false);
  assert.equal(hasStaffPermission("SUPER_ADMIN", "supplier-report.export"), true);
  assert.equal(hasStaffPermission("ADMIN", "supplier-report.export"), false);
  assert.equal(hasStaffPermission("FINANCE", "supplier-report.export"), false);
  assert.equal(hasStaffPermission("ADMIN", "supplier.manage"), true);
  assert.equal(hasStaffPermission("SUPER_ADMIN", "supplier.manage"), true);
  assert.equal(hasStaffPermission("FINANCE", "supplier.manage"), false);
  assert.equal(hasStaffPermission("FINANCE", "costs.read"), true);
  assert.equal(hasStaffPermission("SUPER_ADMIN", "costs.read"), true);
  assert.equal(hasStaffPermission("ADMIN", "costs.read"), false);

  const emailQueue = readFileSync(new URL("../src/server/notifications/reconciliation.ts", import.meta.url), "utf8");
  assert.match(emailQueue, /requireStaffAccess\(headers, "supplier-report\.export"\)/);
  assert.match(emailQueue, /actor\.role !== "SUPER_ADMIN"/);
});

test("overview counts distinguish exact, empty, and lower-bound queue sizes", () => {
  assert.equal(operationsCountLabel(0, "case"), "0 cases");
  assert.equal(operationsCountLabel(1, "case"), "1 case");
  assert.equal(operationsCountLabel(3, "case"), "3 cases");
  assert.equal(operationsCountLabel(18, "placement"), "18 placements");
  assert.equal(operationsCountLabel(100, "event", true), "100+ events");
  assert.equal(operationsCountLabel(-5, "attempt"), "0 attempts");
  assert.deepEqual(boundedQueueCount(99, 100), { count: 99, saturated: false });
  assert.deepEqual(boundedQueueCount(100, 100), { count: 100, saturated: true });
});

test("overview normalizes raw PostgreSQL aggregate timestamps before rendering", () => {
  const rawTimestamp = "2026-11-03T09:15:00.000Z";
  assert.equal(normalizeOperationTimestamp(rawTimestamp).toISOString(), rawTimestamp);
  assert.equal(normalizeOperationTimestamp(new Date(rawTimestamp)).toISOString(), rawTimestamp);
  assert.throws(() => normalizeOperationTimestamp("not-a-timestamp"), /Invalid database timestamp/);
});

test("overview task versions are deterministic and change when task context changes", () => {
  const item = { key: "support:case-1", title: "Case 1", detail: "Investigation", action: "Review", href: "/staff/support/case-1", updatedAt: "2026-11-03T09:15:00.000Z" };
  const version = operationsWorkItemVersion(item);
  assert.match(version, /^[0-9a-f]{64}$/);
  assert.equal(operationsWorkItemVersion(item), version);
  assert.notEqual(operationsWorkItemVersion({ ...item, detail: "Finance review required" }), version);
  assert.notEqual(operationsWorkItemVersion({ ...item, updatedAt: "2026-11-04T09:15:00.000Z" }), version);
  assert.notEqual(operationsWorkItemVersion({ ...item, revision: "1000" }), operationsWorkItemVersion({ ...item, revision: "1001" }),
    "exact financial aggregates change the task version even when two database writes share one JS millisecond");
});

test("overview empty state stays hidden while any actionable queue has work", () => {
  const alert = (count) => ({ key: "queue", title: "Queue", description: "", noun: "item", count, saturated: false, href: "/staff", action: "Open", items: [] });
  assert.equal(hasActionableOperations([]), false);
  assert.equal(hasActionableOperations([alert(0)]), false);
  assert.equal(hasActionableOperations([alert(0), alert(1)]), true);
  assert.equal(hasActionableOperations([alert(100)]), true, "a capped lower-bound queue still counts as open work");
});

test("overview refresh skips hidden tabs and an already-running request", () => {
  assert.equal(shouldRefreshOperationsInbox(true, false, 60_000, 0), true);
  assert.equal(shouldRefreshOperationsInbox(true, false, 59_999, 0), false);
  assert.equal(shouldRefreshOperationsInbox(false, false, 60_000, 0), false);
  assert.equal(shouldRefreshOperationsInbox(true, true, 60_000, 0), false);
  assert.equal(shouldRefreshOperationsInbox(true, false, 30_000, 10_000), false, "automatic refresh respects the 60-second cooldown");
  assert.equal(shouldRefreshOperationsInbox(true, false, 30_000, 10_000, true), true, "a visible manual refresh may retry before the next interval");
  assert.equal(shouldRefreshOperationsInbox(false, false, 30_000, 10_000, true), false, "manual retry still skips hidden tabs");
});

test("an older refresh cannot overwrite a newer Done or Undo action", () => {
  assert.equal(canApplyOperationsRefresh(3, 3), true, "an unchanged attention revision may apply");
  assert.equal(canApplyOperationsRefresh(3, 4), false, "a refresh started before a saved mutation is stale");
});

test("overview reads bounded role-scoped previews and refreshes without full queue reads", () => {
  const alerts = readFileSync(new URL("../src/server/observability/operations-alerts.ts", import.meta.url), "utf8");
  assert.doesNotMatch(alerts, /listFulfillmentQueue/);
  assert.match(alerts, /set_config\('app\.user_id'/);
  assert.match(alerts, /staffSupportAttentionStates\(actor\.role\)/);
  assert.match(alerts, /Cases on orders with items assigned to you and standalone cases appear here/,
    "Admin overview copy matches the order-scoped and standalone case access rules");
  assert.match(alerts, /from\(supportCase\)\.where\(supportScope\)/);
  assert.match(alerts, /isNull\(orderItemFulfillment\.assignedAdminId\)/);
  assert.match(alerts, /limit\(OPERATIONS_INBOX_PREVIEW_LIMIT\)/);
  assert.match(alerts, /data\.attemptsPagination\.total \+ data\.unmatchedEventsPagination\.total[\s\S]*data\.unpacketItemsPagination\.total \+ data\.heldPacketsPagination\.total/,
    "the Overview shows exact actionable totals, not only the first page of previews");
  assert.doesNotMatch(alerts, /noun:\s*"(?:cases|placements|reviews|events|attempts|findings)"/,
    "alert nouns stay singular because the count formatter handles pluralization");
  assert.doesNotMatch(alerts, /articleText|writingBrief|supplierContact|customerEmail|billingAddress|supportCase\.summary|paymentPayload/);
  assert.match(alerts, /hasStaffPermission\(actor\.role, "refund\.pre-handoff\.approve"\)/, "cancellation work follows the staff permission and row-level scope");
  assert.match(alerts, /hasStaffPermission\(actor\.role, "organization\.closure\.manage"\)/, "closure work follows the closure permission and row-level scope");
  assert.match(alerts, /notInArray\(organizationClosureRequest\.state, \["CLOSED"\]\)/, "closed organization requests do not keep Overview nonempty");
  assert.match(alerts, /count\(\*\) over\(\)::int/, "new paged queues count the full filtered queue before limiting previews");
  assert.match(alerts, /ORDER BY attempt\.notice_id, attempt\.created_at DESC, attempt\.id DESC/, "supplier notices use the latest attempt with stable ties");
  assert.match(alerts, /ORDER BY created_at ASC, notice_id ASC[\s\S]*LIMIT \$\{OPERATIONS_INBOX_PREVIEW_LIMIT\}/, "supplier notice previews are bounded and stable");
  assert.doesNotMatch(alerts, /listApprovedAfterDispatchNoticeReconciliation/, "the Overview avoids the notice helper's per-row authorization query");
  assert.match(alerts, /actor\.role === "SUPER_ADMIN"[\s\S]*listUnknownCustomerEmails\(headers\)/, "ambiguous email outcomes are Super Admin only");
  assert.match(alerts, /boundedQueueCount\(unknownEmails\.length, 100\)/, "email outcomes use a clear saturated lower bound at the helper cap");
  assert.match(alerts, /unknownEmails\.slice\(0, OPERATIONS_INBOX_PREVIEW_LIMIT\)/, "email outcome previews stay within four rows");

  assert.match(alerts, /hasStaffPermission\(actor\.role, "supplier\.manage"\)[\s\S]*catalog_import_batch[\s\S]*catalog_import_row/,
    "staged import work is visible only to roles allowed to manage imports");
  assert.match(alerts, /import_row\.status IN \('READY', 'NEEDS_REVIEW', 'DUPLICATE_REVIEW', 'INVALID'\)/,
    "the import summary counts every staged status that still needs review or application");
  assert.match(alerts, /coalesce\(sum\(row_count\), 0\)::int AS total FROM batch_counts/,
    "staged row totals cover every batch instead of the recent-batch page");
  assert.match(alerts, /ORDER BY created_at ASC, batch_id ASC[\s\S]*LIMIT \$\{OPERATIONS_INBOX_PREVIEW_LIMIT\}/,
    "import previews use stable oldest-first ordering and a four-batch limit");
  assert.match(alerts, /Review batch[\s\S]*\/staff\/suppliers\/imports\/\$\{encodeURIComponent\(row\.batchId\)\}/,
    "each import preview links directly to its batch detail");

  assert.match(alerts, /md5\(string_agg\(import_row\.id \|\| ':' \|\| import_row\.xmin::text[\s\S]*revision: row\.revision/,
    "changing one staged row invalidates a dismissal even when the batch date and row count are unchanged");

  assert.match(alerts, /hasStaffPermission\(actor\.role, "costs\.read"\)[\s\S]*latest_placement_cost[\s\S]*allocated_transfers/,
    "supplier coverage is limited to Finance and Super Admin permissions");
  assert.match(alerts, /DISTINCT ON \(cost\.order_item_id, cost\.supplier_id\)[\s\S]*cost\.component = 'PLACEMENT'[\s\S]*cost\.created_at DESC, cost\.id DESC/,
    "coverage selects the latest placement cost using the finance page's stable tie break");
  assert.match(alerts, /sum\(allocation\.amount_minor\)[\s\S]*GROUP BY allocation\.order_item_id, transfer\.supplier_id/,
    "coverage sums allocated transfer amounts once per item and supplier");
  assert.match(alerts, /max\(transfer\.created_at\) AS latest_transfer_at[\s\S]*greatest\(cost\.created_at, allocation\.latest_transfer_at\) AS updated_at/,
    "a later transfer changes the task version so a prior Done state cannot hide updated coverage");
  assert.match(alerts, /allocation\.transferred_minor::text AS transferred_minor[\s\S]*revision: row\.transferredMinor/,
    "sub-millisecond finance changes are bound to the dismissal version without being returned as task detail");
  assert.match(alerts, /const displayItem = \{ \.\.\.item \};\s*delete displayItem\.revision/,
    "internal revision data is removed before the Overview API response");
  assert.match(alerts, /allocation\.order_item_id = cost\.order_item_id AND allocation\.supplier_id = cost\.supplier_id[\s\S]*allocation\.transferred_minor > cost\.confirmed_cost_minor/,
    "only supplier-specific transfers exceeding the latest placement cost are actionable");
  assert.match(alerts, /ORDER BY updated_at ASC, order_item_id ASC, cost_event_id ASC[\s\S]*LIMIT \$\{OPERATIONS_INBOX_PREVIEW_LIMIT\}/,
    "overpayment previews are stably ordered and bounded");
  assert.match(alerts, /Supplier overpayments[\s\S]*Recorded transfer exceeds confirmed placement cost/,
    "Finance previews identify the issue without supplier or transfer details");
  assert.doesNotMatch(alerts, /listStagedImports|getStagedImportRows|getSupplierFinanceData|gphkm_finance_supplier_name|supplierName|supplierContact|transferReference|evidenceReference|original_values|staged_values/,
    "Overview summaries avoid full queue/detail loaders, supplier identity, transfer evidence, and staged payloads");

  const client = readFileSync(new URL("../src/app/staff/(console)/overview-inbox.tsx", import.meta.url), "utf8");
  assert.match(client, /hasActionableOperations\(alerts\)/, "the empty state is based on actionable queue counts");
  assert.match(client, /alerts\.filter\(\(alert\) => alert\.count > 0\)/, "zero-count cards are excluded from the visible work list");
  assert.match(client, /addEventListener\("focus"/);
  assert.match(client, /addEventListener\("visibilitychange"/);
  assert.match(client, /OPERATIONS_INBOX_REFRESH_MS/);
  assert.match(client, /shouldRefreshOperationsInbox\(document\.visibilityState === "visible", inFlightRef\.current, startedAt, lastRequestAtRef\.current, force\)/);
  assert.match(client, /setInterval\(\(\) => \{ void refresh\(\); \}, OPERATIONS_INBOX_REFRESH_MS\)/);
  assert.match(client, /lastRequestAtRef\.current = startedAt/);
  assert.match(client, /fetch\("\/api\/staff\/overview", \{ cache: "no-store"/);
  assert.match(client, /onClick=\{\(\) => \{ void refresh\(true\); \}\}/);
  assert.match(client, /Refresh now/);
  assert.match(client, /role="status" aria-live="polite"/);
  assert.match(client, /setOverviewAttentionDone/);
  assert.match(client, /attentionMutationRevisionRef\.current \+= 1/);
  assert.match(client, /canApplyOperationsRefresh\(attentionRevisionAtStart, attentionMutationRevisionRef\.current\)/);
  assert.match(client, /done \? "Undo" : "Done"/);
  assert.match(client, /Show done/);
  assert.match(client, /It does not close the order, case, or queue item/);
  assert.match(client, /Queue counts include all current work/);

  const actions = readFileSync(new URL("../src/server/observability/attention-actions.ts", import.meta.url), "utf8");
  assert.match(actions, /requireStaffAccess\(requestHeaders, "audit\.read"\)/);
  assert.match(actions, /item\.key === taskKey && item\.version === taskVersion/);
  assert.match(actions, /eq\(staffAttentionDismissal\.taskVersion, taskVersion\)/,
    "Undo deletes only the version that the staff member actually saw");
  assert.match(actions, /onConflictDoUpdate/);
  assert.match(actions, /length > 240/);

  const migration = readFileSync(new URL("../src/db/migrations/0167_staff_attention_dismissal.sql", import.meta.url), "utf8");
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /staff_user_id = nullif\(current_setting\('app\.user_id', true\), ''\)/);
  assert.match(migration, /gphkm_is_active_staff\(nullif\(current_setting\('app\.user_id', true\), ''\)\)/);

  const route = readFileSync(new URL("../src/app/api/staff/overview/route.ts", import.meta.url), "utf8");
  assert.match(route, /requireStaffAccess\(request\.headers, "audit\.read"\)/);
  assert.match(route, /Cache-Control.*private, no-store/);
});
