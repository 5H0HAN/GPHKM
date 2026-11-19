import { authSurfaceOrigins } from "../../server/auth/surfaces.ts";

type Environment = Record<string, string | undefined>;

export const stagingTesterVersions = {
  terms: "terms-staging-testers-2026-11-19-v1",
  privacy: "privacy-staging-testers-2026-11-19-v1",
} as const;

export function stagingTesterEmails(env: Environment): ReadonlySet<string> | null {
  if (env.GPHKM_STAGING_TESTER_NOTICES_ENABLED !== "true" || env.GPHKM_DEPLOYMENT_ENV !== "staging"
    || env.GPHKM_REAL_MONEY_ENABLED !== "false" || env.GPHKM_LAUNCH_GATES_VERIFIED !== "false"
    || env.GPHKM_LOCAL_AUTH_ENABLED === "true" || env.GPHKM_LOCAL_MFA_DISABLED === "true") return null;
  try {
    const origins = authSurfaceOrigins(env);
    if (!origins.customer.startsWith("https://") || !origins.staff.startsWith("https://")) return null;
  } catch { return null; }

  const raw = env.GPHKM_STAGING_GOOGLE_TEST_EMAILS?.trim();
  if (!raw) return null;
  const emails = raw.split(",").map(value => value.trim().toLowerCase());
  // Exact Google mailboxes only. Never interpret wildcard/domain patterns, aliases, or subaddressing.
  const mailbox = /^[a-z0-9_+%-]+(?:\.[a-z0-9_+%-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;
  if (emails.some(email => email.length > 254 || !mailbox.test(email))) return null;
  return new Set(emails);
}
