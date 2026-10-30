import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("customer Settings separates Google recovery from GPHKM password changes", () => {
  const page = readFileSync(new URL("../src/app/customer/settings/page.tsx", import.meta.url), "utf8");
  assert.match(page, /Your Google password and account recovery are managed by Google/);
  assert.match(page, /https:\/\/myaccount\.google\.com\//);
  assert.match(page, /https:\/\/accounts\.google\.com\/signin\/recovery/);
  assert.match(page, /hasPasswordAccount/);
  assert.match(page, /<PasswordChangeForm \/>/);
  assert.match(page, /hasGoogleAccount/);
});
