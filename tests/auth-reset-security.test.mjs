import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("reset tokens are surface-scoped and customer reset requires a password credential", async () => {
  const auth = await readFile(new URL("../src/server/auth/index.ts", import.meta.url), "utf8");
  const domains = await readFile(new URL("../src/server/auth/identity-domain.ts", import.meta.url), "utf8");
  assert.match(auth, /gphkm:\$\{surface\}:\$\{identifier\}/);
  assert.match(auth, /resetTokenAllowedForSurface\(record\.userId, surface\)/);
  assert.match(domains, /!await hasPasswordCredential\(userId\)/);
  assert.match(domains, /!await hasPendingStaffInvitation\(row.email\)/);
  assert.match(domains, /isNotNull\(account\.password\)/);
});
