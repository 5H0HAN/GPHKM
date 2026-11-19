import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { stagingDatabaseUrl, stagingTransaction } from "./staging-setup.mjs";

async function run() {
  stagingDatabaseUrl(process.env);
  const email = (process.env.GPHKM_STAGING_ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (process.argv.length !== 3 || process.argv[2] !== "--mailbox-verified"
      || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || /\.(invalid|example|test|localhost|local)$/.test(email) || process.stdin.isTTY) {
    throw new Error("Mailbox verification and a protected password pipe are required.");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024) throw new Error("Password input too long.");
    chunks.push(chunk);
  }
  const password = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/, "");
  if (password.length < 16 || password.length > 128 || /[\r\n\0]/.test(password)) throw new Error("Invalid password.");
  const hash = await hashPassword(password);
  return stagingTransaction(async (db) => {
    await db.query("LOCK TABLE staff_bootstrap, staff_account, auth_user IN EXCLUSIVE MODE");
    const existing = await db.query(`SELECT EXISTS (SELECT FROM staff_bootstrap) OR EXISTS (SELECT FROM staff_account)
      OR EXISTS (SELECT FROM auth_user WHERE lower(email) = $1) AS unavailable`, [email]);
    if (existing.rows[0].unavailable) throw new Error("Bootstrap is unavailable.");
    const id = randomUUID();
    await db.query("INSERT INTO auth_user (id, name, email, email_verified) VALUES ($1, 'Staging Super Admin', $2, true)", [id, email]);
    await db.query("INSERT INTO auth_account (id, account_id, provider_id, user_id, password) VALUES ($1,$2,'credential',$2,$3)", [randomUUID(), id, hash]);
    await db.query("INSERT INTO staff_account (user_id, role) VALUES ($1,'SUPER_ADMIN')", [id]);
    await db.query("INSERT INTO staff_bootstrap (id, user_id, action) VALUES (1,$1,'STAGING_SUPER_ADMIN_MAILBOX_VERIFIED')", [id]);
    await db.query(`INSERT INTO audit_event (id, actor_user_id, action, target_type, target_id)
      VALUES ($1,$2,'STAGING_SUPER_ADMIN_BOOTSTRAPPED','staff_account',$2)`, [randomUUID(), id]);
    return "Initial staging Super Admin created. Sign in on the staff host to enroll TOTP and save the backup codes.";
  });
}

try {
  console.log(await run());
} catch {
  console.error("Staging staff bootstrap refused. Check the staging runbook, unused bootstrap, verified operator mailbox, and protected password input.");
  process.exitCode = 1;
}
