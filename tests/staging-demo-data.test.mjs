import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const seed = readFileSync(new URL("../scripts/seed-staging-demo.mjs", import.meta.url), "utf8");

test("staging demo data supports one qualifying top-up and consented supplier checkout", () => {
  assert.match(seed, /title: "Demo Garden Journal"[^\n]*price: 5000/,
    "one seeded listing costs the $50 minimum qualifying wallet top-up");
  assert.match(seed, /INSERT INTO supplier_contact[\s\S]*\.invalid/,
    "the synthetic supplier has a non-deliverable primary recipient");
  const existingSeedPath = seed.slice(seed.indexOf("if (seeded.rowCount)"), seed.indexOf("const actorId"));
  assert.match(existingSeedPath, /primary/i,
    "reruns repair a missing primary recipient in an already seeded database");
  assert.match(existingSeedPath, /8500|retail_price_cents/,
    "the price repair only changes the untouched original fixture price");
  assert.match(existingSeedPath, /garden\.rows\[0\]\.revision === 1/,
    "a staff-edited or already repaired listing is not rewritten");
  assert.match(existingSeedPath, /revision = 2, updated_at = now\(\)/,
    "the listing pointer advances atomically with the immutable repair revision");
});
