import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/headers") {
      return { url: moduleUrl("export async function headers(){return new Headers()}") , shortCircuit: true };
    }
    if (specifier === "next/cache") {
      return { url: moduleUrl("export function revalidatePath(){}"), shortCircuit: true };
    }
    if (specifier === "@/server/catalog/metrics") {
      return { url: moduleUrl(`
        export class MetricRefreshError extends Error { constructor(code) { super(code); this.code = code; } }
        export async function refreshOpenPageRank(_headers, ids) {
          if (ids.length === 0) throw new MetricRefreshError("INVALID_SELECTION");
          if (ids[0] === "limit") throw new MetricRefreshError("DAILY_LIMIT");
          return { refreshed: ids.length };
        }
        export async function setMetricRedistributionApproval(_headers, input) {
          if (input.decision === "REVOKED" && input.attributionText !== undefined) throw new Error("Revocation must not submit attribution");
          return { eventId: "synthetic", decision: input.decision };
        }
      `), shortCircuit: true };
    }
    if (specifier === "@/server/observability/safe-log") {
      return { url: moduleUrl("export function logSafeFailure(){}"), shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const actions = await import("../src/app/staff/(console)/metrics/actions.ts");

test("empty refresh selection returns an inline validation error without redirecting", async () => {
  const result = await actions.refreshOpenPageRankAction({ status: "idle" }, new FormData());
  assert.deepEqual(result, {
    status: "error",
    message: "Select between 1 and 100 different listings before refreshing. No provider request was sent.",
  });
});

test("refresh success and daily limit return stable inline messages", async () => {
  const form = new FormData();
  form.append("listingId", "one");
  form.append("listingId", "two");
  assert.deepEqual(await actions.refreshOpenPageRankAction({ status: "idle" }, form), {
    status: "success", message: "Saved 2 metric observations. The latest results are shown above.",
  });

  const limited = new FormData();
  limited.append("listingId", "limit");
  const result = await actions.refreshOpenPageRankAction({ status: "idle" }, limited);
  assert.equal(result.status, "error");
  assert.match(result.message, /five refresh batches in the last 24 hours/);
});

test("revocation omits previous attribution while keeping the review in place", async () => {
  const form = new FormData();
  form.set("observationId", "00000000-0000-4000-8000-000000000000");
  form.set("decision", "REVOKED");
  form.set("attributionText", "Existing attribution");
  form.set("evidenceReference", "LEGAL-REVIEW-123");
  form.set("reason", "Rights review has been withdrawn.");
  assert.deepEqual(await actions.setMetricRedistributionApprovalAction({ status: "idle" }, form), {
    status: "success", message: "Internal attestation revoked.",
  });
});
