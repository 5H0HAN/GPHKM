import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseAccessPolicyUpdate } from "../src/modules/wallet/access-policy.ts";

test("access policy updates accept exact USD and only documented durations", () => {
  assert.deepEqual(parseAccessPolicyUpdate({ minimumUsd: "50.00", duration: "SIX_MONTHS", reason: "Set the launch default" }), {
    minimumMinor: "5000", duration: "SIX_MONTHS", reason: "Set the launch default",
  });
  assert.equal(parseAccessPolicyUpdate({ minimumUsd: "125.25", duration: "ONE_YEAR", reason: "Annual plan approved" }).minimumMinor, "12525");
  assert.equal(parseAccessPolicyUpdate({ minimumUsd: "75", duration: "UNRESTRICTED", reason: "Approved as a trial" }).duration, "UNRESTRICTED");
});

test("access policy update rejects invalid money, duration, and audit reason", () => {
  for (const input of [
    { minimumUsd: "0", duration: "SIX_MONTHS", reason: "Valid reason here" },
    { minimumUsd: "12.345", duration: "SIX_MONTHS", reason: "Valid reason here" },
    { minimumUsd: "25", duration: "ONE_MONTH", reason: "Valid reason here" },
    { minimumUsd: "25", duration: "ONE_YEAR", reason: "short" },
    { minimumUsd: "25", duration: "ONE_YEAR", reason: "bad\nreason with control" },
  ]) assert.throws(() => parseAccessPolicyUpdate(input));
});

test("database update path is Super Admin only, version checked, and audited", async () => {
  const migration = await readFile(new URL("../src/db/migrations/0105_audited_access_policy_command.sql", import.meta.url), "utf8");
  assert.match(migration, /REVOKE UPDATE ON public\.access_policy FROM gphkm_runtime/);
  assert.match(migration, /staff\.active AND staff\.role = 'SUPER_ADMIN'/);
  assert.match(migration, /prior\.version <> expected_version/);
  assert.match(migration, /INSERT INTO public\.audit_event/);
  assert.match(migration, /'ACCESS_POLICY_UPDATED'/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.gphkm_update_access_policy/);
});
