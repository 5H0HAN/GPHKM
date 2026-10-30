import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Next enforces this marker in app builds; the isolated Node test supplies an empty marker.
registerHooks({ resolve(specifier, context, next) {
  return specifier === "server-only"
    ? { url: "data:text/javascript,export{}", shortCircuit: true }
    : next(specifier, context);
} });
const { fetchOpenPageRank, isMetricDomainRefreshable, isOpenPageRankConfigured, isOpenPageRankKeyValid, normalizeMetricDomain } = await import("../src/server/metrics/open-page-rank.ts");

test("provider configuration checks only expose key validity", () => {
  assert.equal(isOpenPageRankConfigured({}), false);
  assert.equal(isOpenPageRankConfigured({ OPEN_PAGE_RANK_API_KEY: "" }), false);
  assert.equal(isOpenPageRankKeyValid("synthetic-provider-key"), true);
  assert.equal(isOpenPageRankKeyValid("invalid\nkey"), false);
  assert.equal(isOpenPageRankConfigured({ OPEN_PAGE_RANK_API_KEY: "synthetic-provider-key" }), true);
});

test("normalizes bare hostnames and rejects URL/IP/credential input", () => {
  assert.equal(normalizeMetricDomain(" EXAMPLE.COM. "), "example.com");
  assert.equal(normalizeMetricDomain("bücher.de"), "xn--bcher-kva.de");
  assert.equal(normalizeMetricDomain("blog.example.co.uk"), "blog.example.co.uk");
  for (const input of ["https://example.com", "example.com/path", "example.com:443", "a@example.com",
    "example.com?x=1", "example.com#x", "example.com%2fpath", "example.com\\path", "127.0.0.1",
    "[::1]", "localhost", "bad..com", "-bad.com", "a".repeat(64) + ".com", "example.123", "a\n.com"]) {
    assert.throws(() => normalizeMetricDomain(input), /Invalid metric domain/);
  }
});

test("reserved demo hostnames are never sent to the metric provider", () => {
  for (const hostname of ["sample-tech.example", "preview.test", "invalid.invalid", "local.localhost", "service.local"]) {
    assert.equal(isMetricDomainRefreshable(hostname), false);
  }
  for (const hostname of ["example.com", "gphkm.com", "shop.example.org"]) {
    assert.equal(isMetricDomainRefreshable(hostname), true);
  }
});

test("fixed provider request and allowlisted observations fail closed", async (t) => {
  const prior = process.env.OPEN_PAGE_RANK_API_KEY;
  process.env.OPEN_PAGE_RANK_API_KEY = "synthetic-offline-key";
  t.after(() => {
    if (prior === undefined) delete process.env.OPEN_PAGE_RANK_API_KEY;
    else process.env.OPEN_PAGE_RANK_API_KEY = prior;
    t.mock.restoreAll();
  });
  let payload = { as_of: "2026-10-01", count: 2, results: [
    { domain: "example.com", found: true, open_page_rank: 0, hosts: [
      { host: "blog.example.com", found: true, open_page_rank: 7.25, private_field: "omit" },
    ], private_field: "omit" },
    { domain: "example.org", found: false, open_page_rank: null },
  ], invalid: [] };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://openpagerank.keywordseverywhere.com/v1/domains/bulk");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer synthetic-offline-key");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { domains: ["blog.example.com", "example.org", "www.example.com"], include_history: false });
    return Response.json(payload);
  });
  const inputs = ["BLOG.EXAMPLE.COM.", "example.org", "example.org", "www.example.com"];
  const result = await fetchOpenPageRank(inputs);
  assert.equal(result[0].value, 7.25);
  assert.equal(result[0].status, "available");
  assert.equal(result[0].requestedTarget, "blog.example.com");
  assert.equal(result[0].normalizedTarget, "blog.example.com");
  assert.equal(result[0].scope, "HOST");
  assert.equal(result[1].value, null);
  assert.equal(result[1].status, "missing");
  assert.equal(result[1].scope, "REGISTERED_DOMAIN");
  assert.equal(result[2].value, 0);
  assert.equal(result[2].scope, "REGISTERED_DOMAIN");
  assert.equal("private_field" in result[0], false);
  payload.results[0].domain = "unrequested.example.net";
  await assert.rejects(fetchOpenPageRank(inputs), /^Error: Open PageRank lookup failed$/);
  payload.results[0].domain = "example.com";
  payload.results[1].open_page_rank = 0;
  await assert.rejects(fetchOpenPageRank(inputs), /Open PageRank lookup failed/);
  payload.results[0].hosts[0].host = "different.example.com";
  await assert.rejects(fetchOpenPageRank(inputs), /Open PageRank lookup failed/);
  t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(256 * 1024 + 1), { headers: { "content-type": "application/json" } }));
  await assert.rejects(fetchOpenPageRank(inputs), /Open PageRank lookup failed/);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("secret synthetic-offline-key"); });
  await assert.rejects(fetchOpenPageRank(inputs), /^Error: Open PageRank lookup failed$/);
  await assert.rejects(fetchOpenPageRank([]), /1 to 100/);
  delete process.env.OPEN_PAGE_RANK_API_KEY;
  await assert.rejects(fetchOpenPageRank(["example.com"]), /missing or invalid/);
});
