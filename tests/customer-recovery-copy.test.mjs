import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("customer Settings directs identity recovery to Google, not GPHKM Support", () => {
  const page = readFileSync(new URL("../src/app/customer/settings/page.tsx", import.meta.url), "utf8");
  assert.match(page, /GPHKM cannot change the Google account used to sign in or recover access to it/);
  assert.match(page, /https:\/\/myaccount\.google\.com\//);
  assert.match(page, /https:\/\/accounts\.google\.com\/signin\/recovery/);
  assert.doesNotMatch(page, /change your verified email or sign-in method, contact Support/);
});
