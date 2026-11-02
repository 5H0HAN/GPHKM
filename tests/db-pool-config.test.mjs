import assert from "node:assert/strict";
import test from "node:test";
import { applicationDbPoolMax } from "../src/db/pool-config.ts";

test("application database pool uses a conservative default and accepts the configured range", () => {
  assert.equal(applicationDbPoolMax(undefined), 5);
  assert.equal(applicationDbPoolMax(" 1 "), 1);
  assert.equal(applicationDbPoolMax("50"), 50);
});

test("application database pool rejects values that could exhaust the deployment limit", () => {
  for (const value of ["0", "-1", "1.5", "51", "1000000", "Infinity", "nope"]) {
    assert.throws(() => applicationDbPoolMax(value), /between 1 and 50/);
  }
});
