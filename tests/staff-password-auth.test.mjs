import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("staff production auth requires TOTP and exact-session proof", async () => {
  const [staffClient, auth, staff, proof, route, migration] = await Promise.all([
    read("../src/auth/staff-client.ts"),
    read("../src/server/auth/index.ts"),
    read("../src/server/auth/staff.ts"),
    read("../src/server/auth/staff-mfa-proof.ts"),
    read("../src/app/api/auth/[...all]/route.ts"),
    read("../src/db/migrations/0197_require_staff_totp.sql"),
  ]);

  assert.match(staffClient, /twoFactorClient\(\{ twoFactorPage: "\/staff\/sign-in\/verify" \}\)/);
  assert.match(auth, /plugins: surface === "customer" \|\| !staffMfaBypassed \? \[twoFactor/);
  assert.match(auth, /issuer: surface === "staff" \? "GPHKM Staff" : "GPHKM"/);
  assert.match(auth, /trustDeviceMaxAge: 0, allowPasswordless: false/);
  assert.match(auth, /requiredMfaProofDatabaseUrl\(process\.env\)/);
  assert.match(staff, /authenticated\.user\.twoFactorEnabled !== true/);
  assert.match(staff, /eq\(staffMfaSession\.sessionId, authenticated\.session\.id\)/);
  assert.match(staff, /eq\(staffMfaSession\.userId, authenticated\.user\.id\)/);
  assert.match(staff, /eq\(twoFactor\.verified, true\)/);
  assert.match(proof, /verify-totp.*TOTP/);
  assert.match(proof, /verify-backup-code.*BACKUP_CODE/);
  assert.doesNotMatch(proof, /verify-otp/);
  assert.match(route, /recordStaffMfaProof\(request, response\)/);
  assert.match(route, /Do not return session cookies when the restricted proof write fails/);
  assert.match(migration, /u\.email_verified/);
  assert.match(migration, /u\.two_factor_enabled/);
  assert.match(migration, /f\.verified/);
  assert.match(migration, /a\.id = target_session_id/);
  assert.match(migration, /gphkm_reset_staff_totp/);
});

test("staff sign-in, invitation enrollment, and activation use the staff MFA flow", async () => {
  const [signIn, verify, invitation, enrollment, team] = await Promise.all([
    read("../src/app/sign-in/sign-in-form.tsx"),
    read("../src/app/staff/sign-in/verify/page.tsx"),
    read("../src/app/staff/invitations/accept/staff-invitation-acceptance.tsx"),
    read("../src/components/identity/totp-enrollment-form.tsx"),
    read("../src/app/staff/(console)/team/page.tsx"),
  ]);

  assert.match(signIn, /surface === "staff" \? staffAuthClient : authClient/);
  assert.match(signIn, /client\.twoFactor\.verifyTotp/);
  assert.match(signIn, /client\.twoFactor\.verifyBackupCode/);
  assert.match(verify, /surface="staff"/);
  assert.match(invitation, /TotpEnrollmentForm surface="staff"/);
  assert.match(enrollment, /surface === "staff" \? "GPHKM Staff" : "GPHKM"/);
  assert.match(team, /member\.emailVerified && member\.totpReady/);
  assert.match(team, /!isCurrentUser && <form action=\{resetStaffTotpAction\}>/);
  assert.doesNotMatch(team, /!isCurrentUser && member\.totpReady && <form action=\{resetStaffTotpAction\}>/);
  assert.match(team, /Reset authenticator/);
  assert.match(team, /TOTP verified/);
});
