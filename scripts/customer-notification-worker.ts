import { invitationUrl } from "../src/server/auth/link-builders.ts";
import { publicBaseOrigin } from "../src/server/auth/url-policy.ts";
import { authSurfaceOrigins } from "../src/server/auth/surfaces.ts";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { assertInvitationTokenEncryptionConfigured, decryptInvitationToken } from "../src/modules/identity/invitation-crypto.ts";
import { readSmallJsonResponse } from "../src/modules/security/small-json-response.ts";
import { assertPrivateFileStorageConfigured, deletePrivateFile } from "../src/server/storage/private-files.ts";
import { mailSenders } from "../src/modules/email/senders.ts";

type ClaimedEmail = {
  kind: "CUSTOMER_NOTIFICATION";
  outbox_id: string;
  recipient_email: string;
  email_verified: boolean;
  email_enabled: boolean;
  subject: string;
  body: string;
  notification_kind: "ORDER_MILESTONE" | "ORDER_ACTION" | "SUPPORT_UPDATE";
  attempts: number;
  first_attempt_at: Date;
};

type ClaimedInvitation = {
  kind: "INVITATION";
  outbox_id: string;
  recipient_email: string;
  invitation_kind: "ORGANIZATION" | "STAFF";
  invitation_id: string;
  token_ciphertext: string;
  token_nonce: string;
  token_tag: string;
  organization_name: string | null;
  staff_role: "ADMIN" | "FINANCE" | null;
  expires_at: Date;
  attempts: number;
  first_attempt_at: Date;
};

type ClaimedPrivateFile = { storage_key: string };
type MailSettings = {
  apiKey: string;
  systemFrom: string;
  supportFrom: string;
  publicBase: URL;
  customerBase: URL;
  staffBase: URL;
};

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Customer notification worker configuration is incomplete");
  return value;
};
const workerUrl = required("WORKER_DATABASE_URL");
const privateFileCleanupEnabled = Boolean(process.env.GPHKM_PRIVATE_STORAGE_DRIVER?.trim()
  || (process.env.NODE_ENV === "development" && process.env.GPHKM_PRIVATE_STORAGE_PATH?.trim()));
const mailSettings: MailSettings | null = process.env.GPHKM_RESEND_DATA_HANDLING_APPROVED === "true" ? (() => {
  const apiKey = required("RESEND_API_KEY");
  const senders = mailSenders(process.env);
  const publicBase = publicBaseOrigin(process.env);
  if (!publicBase) throw new Error("Customer notification public ingress is missing");
  const origins = authSurfaceOrigins(process.env);
  const customerBase = new URL(origins.customer);
  const staffBase = new URL(origins.staff);
  if ([customerBase, staffBase].some((base) => base.username !== "" || base.password !== ""
      || (base.protocol !== "https:" && base.hostname !== "localhost" && !base.hostname.endsWith(".localhost"))
      || base.pathname !== "/" || base.search || base.hash)
    || publicBase.protocol !== "https:" || publicBase.username !== "" || publicBase.password !== ""
    || publicBase.pathname !== "/" || publicBase.search || publicBase.hash) {
    throw new Error("Customer notification sender or URL settings are invalid");
  }
  assertInvitationTokenEncryptionConfigured();
  return {
    apiKey, systemFrom: senders.system, supportFrom: senders.support, publicBase, customerBase, staffBase,
  };
})() : null;

const client = new Client({ connectionString: workerUrl });
const workerId = randomUUID();
let running = true;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

async function finish(job: ClaimedEmail, state: "SENT" | "RETRY" | "UNKNOWN" | "FAILED" | "SKIPPED", input: {
  reference?: string; errorCode?: string; nextAttemptAt?: Date;
} = {}) {
  const result = await client.query<{ applied: boolean }>(
    "select public.gphkm_finish_customer_notification_email($1,$2,$3,$4,$5,$6) as applied",
    [job.outbox_id, workerId, state, input.reference ?? null, input.errorCode ?? null, input.nextAttemptAt ?? null],
  );
  if (!result.rows[0]?.applied) throw new Error("Customer notification delivery lease is no longer current");
}

async function finishInvitation(job: ClaimedInvitation, state: "SENT" | "RETRY" | "UNKNOWN" | "FAILED" | "SKIPPED", input: {
  reference?: string; errorCode?: string; nextAttemptAt?: Date;
} = {}) {
  const result = await client.query<{ applied: boolean }>(
    "select public.gphkm_finish_invitation_email($1,$2,$3,$4,$5,$6) as applied",
    [job.outbox_id, workerId, state, input.reference ?? null, input.errorCode ?? null, input.nextAttemptAt ?? null],
  );
  if (!result.rows[0]?.applied) throw new Error("Invitation delivery lease is no longer current");
}

function retryAt(job: Pick<ClaimedEmail, "attempts" | "first_attempt_at">) {
  const first = new Date(job.first_attempt_at).getTime();
  const safeRetryUntil = first + 23 * 60 * 60 * 1000;
  if (!Number.isFinite(first) || Date.now() >= safeRetryUntil) return null;
  const delay = Math.min(30_000 * 2 ** Math.min(Math.max(job.attempts - 1, 0), 6), 30 * 60_000);
  return new Date(Math.min(Date.now() + delay, safeRetryUntil));
}

function invitationRetryAt(job: ClaimedInvitation) {
  return retryAt(job);
}

async function sendOne(job: ClaimedEmail) {
  if (!mailSettings) throw new Error("Customer notification delivery is disabled");
  if (!job.email_enabled) return finish(job, "SKIPPED", { errorCode: "EMAIL_PREFERENCE_DISABLED" });
  if (!job.email_verified || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(job.recipient_email)) {
    return finish(job, "FAILED", { errorCode: "RECIPIENT_UNVERIFIED" });
  }
  const text = `${job.subject}\n\n${job.body}\n\nView your notifications: ${new URL("/customer/notifications", mailSettings.customerBase).toString()}`;
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${mailSettings.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `gphkm-customer-${job.outbox_id}`,
      },
      body: JSON.stringify({ from: job.notification_kind === "SUPPORT_UPDATE" ? mailSettings.supportFrom : mailSettings.systemFrom, to: [job.recipient_email], subject: job.subject, text,
        tags: [{ name: "gphkm_outbox", value: job.outbox_id }] }),
    });
  } catch {
    await finish(job, "UNKNOWN", { errorCode: "NETWORK_OUTCOME_UNKNOWN" });
    console.log(JSON.stringify({ event: "customer_notification_email_unknown", outboxId: job.outbox_id }));
    return;
  }
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      const next = retryAt(job);
      if (next) {
        await finish(job, "RETRY", { errorCode: response.status === 429 ? "PROVIDER_RATE_LIMIT" : "PROVIDER_TEMPORARY", nextAttemptAt: next });
        return;
      }
      await finish(job, "UNKNOWN", { errorCode: "IDEMPOTENCY_WINDOW_REVIEW" });
      return;
    }
    await finish(job, response.status === 409 ? "UNKNOWN" : "FAILED", {
      errorCode: response.status === 409 ? "IDEMPOTENCY_CONFLICT_REVIEW" : "PROVIDER_REJECTED",
    });
    return;
  }
  let responseId: unknown;
  try { responseId = (await readSmallJsonResponse<{ id?: unknown }>(response)).id; } catch { responseId = null; }
  if (typeof responseId !== "string" || responseId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(responseId)) {
    await finish(job, "UNKNOWN", { errorCode: "PROVIDER_REFERENCE_MISSING" });
    return;
  }
  await finish(job, "SENT", { reference: responseId });
  console.log(JSON.stringify({ event: "customer_notification_email_accepted", outboxId: job.outbox_id, providerReference: responseId }));
}

async function sendInvitation(job: ClaimedInvitation) {
  if (!mailSettings) throw new Error("Invitation delivery is disabled");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(job.recipient_email)) {
    return finishInvitation(job, "FAILED", { errorCode: "RECIPIENT_INVALID" });
  }
  let token: string;
  try {
    token = decryptInvitationToken({ ciphertext: job.token_ciphertext, nonce: job.token_nonce, tag: job.token_tag }, `${job.invitation_kind}:${job.invitation_id}`);
  } catch {
    return finishInvitation(job, "FAILED", { errorCode: "TOKEN_DECRYPT_FAILED" });
  }
  const link = invitationUrl(process.env, job.invitation_kind, token, job.invitation_kind === "STAFF" ? job.recipient_email : undefined);
  const subject = job.invitation_kind === "ORGANIZATION" ? "You’re invited to GPHKM" : "GPHKM staff invitation";
  const audience = job.invitation_kind === "ORGANIZATION" ? `organization ${job.organization_name ?? ""}` : `GPHKM staff as ${job.staff_role ?? "staff"}`;
  const text = `You have been invited to join ${audience}.\n\nAccept the invitation using this secure link:\n${link}\n\nThis invitation expires ${new Date(job.expires_at).toISOString()}. If you were not expecting it, ignore this email.`;
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${mailSettings.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `gphkm-invitation-${job.outbox_id}`,
      },
      body: JSON.stringify({ from: mailSettings.systemFrom, to: [job.recipient_email], subject, text,
        tags: [{ name: "gphkm_invitation", value: job.outbox_id }] }),
    });
  } catch {
    await finishInvitation(job, "UNKNOWN", { errorCode: "NETWORK_OUTCOME_UNKNOWN" });
    console.log(JSON.stringify({ event: "invitation_email_unknown", outboxId: job.outbox_id }));
    return;
  }
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      const next = invitationRetryAt(job);
      if (next) return finishInvitation(job, "RETRY", { errorCode: response.status === 429 ? "PROVIDER_RATE_LIMIT" : "PROVIDER_TEMPORARY", nextAttemptAt: next });
      return finishInvitation(job, "UNKNOWN", { errorCode: "IDEMPOTENCY_WINDOW_REVIEW" });
    }
    return finishInvitation(job, response.status === 409 ? "UNKNOWN" : "FAILED", {
      errorCode: response.status === 409 ? "IDEMPOTENCY_CONFLICT_REVIEW" : "PROVIDER_REJECTED",
    });
  }
  let responseId: unknown;
  try { responseId = (await readSmallJsonResponse<{ id?: unknown }>(response)).id; } catch { responseId = null; }
  if (typeof responseId !== "string" || responseId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(responseId)) {
    await finishInvitation(job, "UNKNOWN", { errorCode: "PROVIDER_REFERENCE_MISSING" });
    return;
  }
  await finishInvitation(job, "SENT", { reference: responseId });
  console.log(JSON.stringify({ event: "invitation_email_accepted", outboxId: job.outbox_id, providerReference: responseId }));
}

async function finishPrivateFileDelete(storageKey: string, succeeded: boolean) {
  const result = await client.query<{ applied: boolean }>(
    "select public.gphkm_finish_private_file_delete($1,$2,$3) as applied",
    [storageKey, workerId, succeeded],
  );
  return result.rows[0]?.applied === true;
}

async function cleanupOnePrivateFile() {
  const result = await client.query<ClaimedPrivateFile>(
    "select * from public.gphkm_claim_private_file_deletes($1,$2)", [workerId, 1],
  );
  const file = result.rows[0];
  if (!file) return false;

  try {
    await deletePrivateFile(file.storage_key);
    await finishPrivateFileDelete(file.storage_key, true);
    console.log(JSON.stringify({ event: "private_file_cleanup_completed" }));
  } catch {
    await finishPrivateFileDelete(file.storage_key, false).catch(() => false);
    console.error(JSON.stringify({ event: "private_file_cleanup_retry_scheduled" }));
  }
  return true;
}

async function main() {
  if (privateFileCleanupEnabled) assertPrivateFileStorageConfigured();
  await client.connect();
  console.log(JSON.stringify({ event: "gphkm_worker_started", workerId, privateFileCleanup: privateFileCleanupEnabled, notifications: mailSettings !== null }));
  while (running) {
    const privateFileWorked = privateFileCleanupEnabled ? await cleanupOnePrivateFile() : false;
    if (mailSettings) {
      const invitationResult = await client.query<ClaimedInvitation>(
        "select 'INVITATION'::text as kind, * from public.gphkm_claim_invitation_emails($1,$2)", [workerId, 1],
      );
      const invitation = invitationResult.rows[0];
      if (invitation) {
        try { await sendInvitation(invitation); }
        catch {
          console.error(JSON.stringify({ event: "invitation_email_worker_state_error", outboxId: invitation.outbox_id }));
          process.exitCode = 1;
          break;
        }
        continue;
      }
      const result = await client.query<ClaimedEmail>(
        "select 'CUSTOMER_NOTIFICATION'::text as kind, * from public.gphkm_claim_customer_notification_emails($1,$2)", [workerId, 1],
      );
      const job = result.rows[0];
      if (job) {
        try { await sendOne(job); }
        catch {
          // If the provider may have accepted the message, the lease expires into UNKNOWN and is never retried automatically.
          console.error(JSON.stringify({ event: "customer_notification_worker_state_error", outboxId: job.outbox_id }));
          process.exitCode = 1;
          break;
        }
        continue;
      }
    }
    if (!privateFileWorked) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

main().catch(() => {
  console.error("GPHKM worker stopped; check private storage, notification provider settings, and database health.");
  process.exitCode = 1;
}).finally(async () => { await client.end().catch(() => undefined); });
