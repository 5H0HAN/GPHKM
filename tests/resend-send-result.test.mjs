import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isDefinitiveResendRejection, readResendMessageId } from "../src/modules/fulfillment/resend-send-result.ts";

test("Resend idempotency conflicts and server errors require reconciliation", () => {
  assert.equal(isDefinitiveResendRejection(409), false);
  assert.equal(isDefinitiveResendRejection(503), false);
  assert.equal(isDefinitiveResendRejection(422), true);
});

test("Resend send acceptance requires a bounded string message ID", async () => {
  assert.equal(await readResendMessageId(Response.json({ id: "message_A-123" })), "message_A-123");
  for (const id of [undefined, null, 123, { value: "id" }, ["id"], "", "line\nbreak", "a".repeat(129)]) {
    assert.equal(await readResendMessageId(Response.json({ id })), null);
  }
  assert.equal(await readResendMessageId(new Response("invalid JSON", { headers: { "content-type": "application/json" } })), null);
});

test("both supplier send paths reconcile conflicts and unusable message IDs", async () => {
  for (const file of ["packets.ts", "supplier-notices.ts"]) {
    const source = await readFile(new URL(`../src/server/fulfillment/${file}`, import.meta.url), "utf8");
    assert.match(source, /isDefinitiveResendRejection\(response.status\)[\s\S]*"RECONCILED_FAILED"\s*:\s*"UNKNOWN"/);
    assert.match(source, /await readResendMessageId\(response\);\s*if \(!providerReference\) \{[\s\S]*"UNKNOWN"/);
  }
});
