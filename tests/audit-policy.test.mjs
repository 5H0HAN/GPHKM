import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("audit read RLS is role-scoped and customer rows are not directly readable", async () => {
  const sql = await readFile(new URL("../src/db/migrations/0014_audit_visibility.sql", import.meta.url), "utf8");
  assert.match(sql, /DROP POLICY audit_event_tenant_read/);
  assert.match(sql, /gphkm_is_active_staff\([^\n]+, 'SUPER_ADMIN'\)/);
  assert.match(sql, /assigned_admin_id = nullif\(current_setting\('app.user_id'/);
  assert.match(sql, /action LIKE 'WALLET_%'/);
  assert.doesNotMatch(sql, /CREATE POLICY audit_event_tenant_read/);
});

test("staff audit feed is keyset-paginated and projects only the needed metadata field", async () => {
  const read = await readFile(new URL("../src/server/audit/read.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/app/staff/(console)/audit/page.tsx", import.meta.url), "utf8");
  const migration = await readFile(new URL("../src/db/migrations/0097_audit_event_cursor_index.sql", import.meta.url), "utf8");
  assert.match(read, /requireStaffAccess\(headers, "audit\.read"\)/);
  assert.match(read, /metadata\}->>'result'/);
  assert.match(read, /\.limit\(51\)/);
  assert.match(read, /lt\(auditEvent\.id, cursor\.id\)/);
  assert.doesNotMatch(read, /metadata: auditEvent\.metadata/);
  assert.match(page, /Older events/);
  assert.match(migration, /audit_event_created_cursor_idx/);
});
