import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("finance reconciliation stays on its page and reports a refreshed result", async () => {
  const actions = await readFile(new URL("../src/app/staff/(console)/reconciliation/finance-actions.ts", import.meta.url), "utf8");
  const control = await readFile(new URL("../src/app/staff/(console)/reconciliation/run-reconciliation-control.tsx", import.meta.url), "utf8");
  const start = actions.indexOf("export async function runFinanceReconciliationAction");
  const end = actions.indexOf("export async function recordFinanceFindingActionAction", start);
  const runAction = actions.slice(start, end);
  assert.match(runAction, /runFinanceReconciliation\(await headers\(\)\)/);
  assert.match(runAction, /revalidatePath\("\/staff\/reconciliation"\)/);
  assert.match(runAction, /return \{ status: "success", runId \}/);
  assert.doesNotMatch(runAction, /redirect\(/);
  assert.match(control, /disabled=\{pending\}/);
  assert.match(control, /router\.refresh\(\)/);
  assert.match(control, /Reconciliation finished/);
  assert.match(control, /role="alert"/);
});
