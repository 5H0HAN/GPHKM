import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

test("system and support mail use separate same-domain sender addresses", async () => {
  const { mailSenders } = await tsImport("../src/modules/email/senders.ts", import.meta.url);
  assert.deepEqual(mailSenders({
    RESEND_SYSTEM_FROM_EMAIL: "no-reply@example.test",
    RESEND_SUPPORT_FROM_EMAIL: "support@example.test",
  }), {
    system: "no-reply@example.test",
    support: "support@example.test",
    domain: "example.test",
  });
});

test("sender configuration rejects domain mismatches, unexpected mailboxes and header injection", async () => {
  const { mailSenders } = await tsImport("../src/modules/email/senders.ts", import.meta.url);
  for (const env of [
    { RESEND_SYSTEM_FROM_EMAIL: "no-reply@example.test", RESEND_SUPPORT_FROM_EMAIL: "support@example.org" },
    { RESEND_SYSTEM_FROM_EMAIL: "system@example.test", RESEND_SUPPORT_FROM_EMAIL: "support@example.test" },
    { RESEND_SYSTEM_FROM_EMAIL: "no-reply@example.test\r\nBcc: bad@example.test", RESEND_SUPPORT_FROM_EMAIL: "support@example.test" },
    { RESEND_SYSTEM_FROM_EMAIL: "no-reply@example.test", RESEND_SUPPORT_FROM_EMAIL: "" },
  ]) assert.throws(() => mailSenders(env), /sender/i);
});
