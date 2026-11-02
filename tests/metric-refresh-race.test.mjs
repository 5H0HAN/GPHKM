import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import test from "node:test";

const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: moduleUrl("export{}"), shortCircuit: true };
  if (specifier === "drizzle-orm") return { url: moduleUrl(`
    export const and=(...values)=>values, asc=(value)=>value, desc=(value)=>value;
    export const eq=(...values)=>values, inArray=(...values)=>values;
    export function sql(strings,...values){return {strings,values}}
  `), shortCircuit: true };
  if (specifier === "@/db") return { url: moduleUrl(`
    const getState=()=>globalThis.__gphkmMetricRefreshRaceTest;
    function query(resolveRows){
      const builder={
        from(table){this.table=table;return this}, innerJoin(){return this}, where(){return this},
        orderBy(){return this}, for(){return this}, limit(){return this},
        then(resolve,reject){return Promise.resolve(resolveRows(this)).then(resolve,reject)}
      };
      return builder;
    }
    export const db={
      async transaction(run){
        const tx={
          async execute(){return {}},
          select(fields){return query((builder)=>{
            if(fields.count) return [{count:0}];
            if(fields.id==="listing.id") return [{id:getState().listingId,...getState().capturedUrl}];
            if(fields.listingId==="listingUrl.listingId") return [{listingId:getState().listingId,...getState().currentUrl}];
            throw new Error("Unexpected metrics refresh select");
          })},
          insert(){return {async values(rows){getState().inserted.push(...rows)}}}
        };
        return run(tx);
      }
    };
  `), shortCircuit: true };
  if (specifier === "@/db/catalog-schema") return { url: moduleUrl(`
    export const listing={id:"listing.id"};
    export const listingUrl={listingId:"listingUrl.listingId",websiteUrl:"listingUrl.websiteUrl",updatedAt:"listingUrl.updatedAt"};
    export const listingMetricApprovalEvent={}, listingMetricObservation={
      listingId:"metric.listingId",provider:"metric.provider",metricScope:"metric.metricScope",refreshedAt:"metric.refreshedAt"
    };
  `), shortCircuit: true };
  if (specifier === "@/db/schema") return { url: moduleUrl(`export const auditEvent={actorUserId:"audit.actor",action:"audit.action",createdAt:"audit.createdAt"}`), shortCircuit: true };
  if (specifier === "@/server/audit/append") return { url: moduleUrl(`
    export async function appendAuditEvent(_tx,event){globalThis.__gphkmMetricRefreshRaceTest.auditActions.push(event.action)}
  `), shortCircuit: true };
  if (specifier === "@/server/auth/staff") return { url: moduleUrl(`
    export async function requireStaffAccess(){return {userId:"fixture-admin",role:"ADMIN"}}
  `), shortCircuit: true };
  if (specifier === "@/modules/catalog/metric-approval") return { url: moduleUrl(`
    export function validateMetricRedistributionDecision(value){return value}
  `), shortCircuit: true };
  if (specifier === "@/modules/catalog/pagination") return { url: moduleUrl(`export function staffCatalogPagination(){return {}}`), shortCircuit: true };
  if (specifier === "@/server/metrics/open-page-rank") {
    return { url: pathToFileURL(resolve("src/server/metrics/open-page-rank.ts")).href, shortCircuit: true };
  }
  if (specifier === "@/modules/catalog/metric-refresh") {
    return { url: pathToFileURL(resolve("src/modules/catalog/metric-refresh.ts")).href, shortCircuit: true };
  }
  return next(specifier, context);
} });

const serviceSource = await readFile(new URL("../src/server/catalog/metrics.ts", import.meta.url), "utf8");
const serviceModule = ts.transpileModule(serviceSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { refreshOpenPageRank } = await import(moduleUrl(serviceModule));

test("an A → B → A URL change while provider I/O is pending rejects and audits the stale refresh", async (t) => {
  const state = {
    listingId: "00000000-0000-4000-8000-000000000001",
    capturedUrl: { websiteUrl: "https://history.fixture.com/", urlVersion: "1793649186.000001" },
    currentUrl: { websiteUrl: "https://history.fixture.com/", version: "1793649186.000001" },
    auditActions: [], inserted: [],
  };
  globalThis.__gphkmMetricRefreshRaceTest = state;
  t.after(() => { delete globalThis.__gphkmMetricRefreshRaceTest; t.mock.restoreAll(); });

  const previousKey = process.env.OPEN_PAGE_RANK_API_KEY;
  process.env.OPEN_PAGE_RANK_API_KEY = "synthetic-race-test-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPEN_PAGE_RANK_API_KEY;
    else process.env.OPEN_PAGE_RANK_API_KEY = previousKey;
  });

  let providerStartedResolve;
  let responseResolve;
  const providerStarted = new Promise((resolveStarted) => { providerStartedResolve = resolveStarted; });
  const providerResponse = new Promise((resolveResponse) => { responseResolve = resolveResponse; });
  t.mock.method(globalThis, "fetch", async () => {
    providerStartedResolve();
    return providerResponse;
  });

  const refresh = refreshOpenPageRank(new Headers(), [state.listingId]);
  await providerStarted;
  state.currentUrl = { websiteUrl: "https://blog.history.fixture.com/", version: "1793649186.000002" };
  state.currentUrl = { websiteUrl: "https://history.fixture.com/", version: "1793649186.000003" };
  responseResolve(Response.json({
    as_of: "2026-11-02", count: 1,
    results: [{ domain: "history.fixture.com", found: true, open_page_rank: 4.25 }], invalid: [],
  }));

  await assert.rejects(refresh, /Metric refresh failed\. The attempt was recorded for review\./);
  assert.deepEqual(state.inserted, [], "the provider result is not persisted after URL reversion");
  assert.deepEqual(state.auditActions, ["METRICS_REFRESH_STARTED", "METRICS_REFRESH_FAILED"],
    "the attempted refresh remains auditable and is not marked complete");
});
