import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("email verification pages require explicit confirmation without exposing referrers or cacheable tokens", async () => {
  const [config, page, component] = await Promise.all([
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/sign-in/confirm-email/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/sign-in/confirm-email.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(config, /"\/sign-in\/confirm-email", "\/staff\/sign-in\/confirm-email"/);
  assert.match(config, /\{ key: "Cache-Control", value: "no-store" \}/);
  assert.match(config, /\{ key: "Referrer-Policy", value: "no-referrer" \}/);
  assert.match(page, /referrer: "no-referrer"/);
  assert.match(component, /action="\/api\/auth\/verify-email" method="get"/);
  assert.match(component, /name="token" value=\{token\}/);
  assert.match(component, /name="callbackURL" value=\{callbackURL\}/);
  assert.match(component, /<button[^>]*>Verify email<\/button>/);
});
