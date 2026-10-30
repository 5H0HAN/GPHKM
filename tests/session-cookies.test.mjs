import assert from "node:assert/strict";
import test from "node:test";
import { mergeSessionCookies } from "../src/server/auth/session-cookies.ts";

test("MFA proof uses the newly returned session cookie and drops expired challenge cookies", () => {
  assert.equal(
    mergeSessionCookies("__Secure-session=old; two_factor=challenge; theme=dark", [
      "__Secure-session=new; Path=/; HttpOnly; Secure; SameSite=Lax",
      "two_factor=; Path=/; Max-Age=0; HttpOnly",
    ]),
    "__Secure-session=new; theme=dark",
  );
});

test("cookie merge preserves unrelated cookies and quoted values", () => {
  assert.equal(mergeSessionCookies('a="quoted value"; b=z', ["c=value; Path=/"]), 'a="quoted value"; b=z; c=value');
});
