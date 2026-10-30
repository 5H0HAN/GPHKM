import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("customer and staff MFA flows use their own host-local verification routes", async () => {
  const customerClient = await readFile(new URL("../src/auth/client.ts", import.meta.url), "utf8");
  const staffClient = await readFile(new URL("../src/auth/staff-client.ts", import.meta.url), "utf8");
  const signInForm = await readFile(new URL("../src/app/sign-in/sign-in-form.tsx", import.meta.url), "utf8");
  const staffSignIn = await readFile(new URL("../src/app/staff/sign-in/staff-sign-in.tsx", import.meta.url), "utf8");
  const staffVerify = await readFile(new URL("../src/app/staff/sign-in/verify/page.tsx", import.meta.url), "utf8");

  assert.match(customerClient, /twoFactorPage:\s*"\/sign-in\/verify"/);
  assert.match(staffClient, /twoFactorPage:\s*"\/staff\/sign-in\/verify"/);
  assert.match(signInForm, /surface === "staff" \? staffAuthClient : authClient/);
  assert.match(signInForm, /callbackURL:\s*surface === "staff" \? "\/staff\/sign-in" : "\/sign-in"/);
  assert.match(staffSignIn, /href="\/staff\/sign-in\/verify"/);
  assert.match(staffSignIn, /surface="staff"/);
  assert.match(staffVerify, /surface="staff"/);
});
