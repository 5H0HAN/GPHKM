import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("staff navigation announces the active route without widening role permissions", async () => {
  const nav = await readFile(new URL("../src/app/staff/(console)/staff-nav.tsx", import.meta.url), "utf8");
  const layout = await readFile(new URL("../src/app/staff/(console)/layout.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/app/staff/(console)/console.module.css", import.meta.url), "utf8");
  const signOut = await readFile(new URL("../src/app/staff/(console)/staff-signout.tsx", import.meta.url), "utf8");
  assert.match(nav, /aria-current=\{pathname === item\.href/);
  assert.match(nav, /aria-label="Staff workspace"/);
  assert.match(layout, /hasStaffPermission\(actor\.role, item\.permission\)/);
  assert.match(styles, /\.navLink\[aria-current="page"\]/);
  assert.match(signOut, /authClient\.signOut\(\)/);
  assert.match(signOut, /if \(result\.error\)/);
  assert.match(signOut, /role="alert"/);
});
