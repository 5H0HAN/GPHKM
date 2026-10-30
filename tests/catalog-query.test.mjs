import assert from "node:assert/strict";
import test from "node:test";
import { firstQueryValue } from "../src/modules/query-params.ts";

test("catalog page query parsing normalizes repeated scalar parameters", () => {
  assert.equal(firstQueryValue("technology"), "technology");
  assert.equal(firstQueryValue(["technology", "business"]), "technology");
  assert.equal(firstQueryValue([]), undefined);
  assert.equal(firstQueryValue(undefined), undefined);
});
