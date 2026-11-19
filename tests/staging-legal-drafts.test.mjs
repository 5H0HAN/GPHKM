import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { tsImport } from "tsx/esm/api";
import { stagingDrafts, stagingDraftVersion } from "../src/app/legal/drafts/documents.ts";
import { currentLegalDocuments, LegalConfigurationError } from "../src/modules/legal/policy.ts";

const origins = {
  NODE_ENV: "production", CUSTOMER_APP_URL: "https://app.example.test",
  STAFF_APP_URL: "https://staff.example.test", GPHKM_PUBLIC_BASE_URL: "https://example.test",
};
const versions = ["terms-2026-11-19-v1", "privacy-2026-11-19-v1"];

test("only named staging draft versions resolve and draft URLs cannot satisfy the acceptance gate", () => {
  for (const version of versions) {
    assert.equal(stagingDraftVersion("staging", version), version);
    assert.equal(stagingDraftVersion("production", version), null);
    assert.equal(stagingDraftVersion(undefined, version), null);
    assert.match(stagingDrafts[version].introduction, /review and has no effective date/);
    const url = origins.CUSTOMER_APP_URL + "/legal/drafts/" + version;
    const configured = { ...origins, GPHKM_TERMS_VERSION: versions[0], GPHKM_PRIVACY_VERSION: versions[1],
      GPHKM_TERMS_URL: "https://app.example.test/legal/terms", GPHKM_PRIVACY_URL: "https://app.example.test/legal/privacy" };
    for (const key of ["GPHKM_TERMS_URL", "GPHKM_PRIVACY_URL"]) {
      assert.throws(() => currentLegalDocuments({ ...configured, [key]: url }), LegalConfigurationError);
    }
  }
  assert.equal(stagingDraftVersion("staging", "constructor"), null);
  assert.equal(stagingDraftVersion("staging", "terms"), null);
});

test("staging customer host serves review GET and HEAD without sign-in, other hosts and methods fail closed", async (t) => {
  t.mock.property(process, "env", { ...origins, GPHKM_DEPLOYMENT_ENV: "staging" });
  const { proxy } = await tsImport("../src/proxy.ts", import.meta.url);
  const request = (host, method) => proxy(new NextRequest(`https://${host}/legal/drafts/${versions[0]}`, { method, headers: { host } }));
  for (const method of ["GET", "HEAD"]) {
    assert.equal(request("app.example.test", method).headers.get("x-middleware-next"), "1");
    assert.equal(request("staff.example.test", method).status, 404);
    assert.equal(request("example.test", method).status, 404);
  }
  assert.equal(request("app.example.test", "POST").status, 404);
  delete process.env.GPHKM_DEPLOYMENT_ENV;
  assert.equal(request("app.example.test", "GET").status, 404);
});
