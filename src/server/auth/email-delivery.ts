import "server-only";
import { randomUUID } from "node:crypto";
import { mailSenders } from "../../modules/email/senders.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function configuration() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  let from: string;
  try { from = mailSenders(process.env).system; } catch { return null; }
  if (process.env.GPHKM_RESEND_DATA_HANDLING_APPROVED !== "true" || !apiKey || !EMAIL_RE.test(from)) return null;
  return { apiKey, from };
}

export function authEmailAvailable() {
  return configuration() !== null;
}

type AuthEmailKind = "verification" | "password_reset" | "welcome";
type AuthEmailFailureClass = "configuration_unavailable" | "invalid_request" | "provider_rejected";

class AuthEmailDeliveryError extends Error {
  readonly failureClass: AuthEmailFailureClass;
  readonly providerStatus?: number;

  constructor(failureClass: AuthEmailFailureClass, providerStatus?: number) {
    super("Customer authentication email delivery failed");
    this.failureClass = failureClass;
    this.providerStatus = providerStatus;
  }
}

export async function sendAuthEmail(input: { kind: AuthEmailKind; to: string; subject: string; text: string }) {
  const config = configuration();
  if (!config) throw new AuthEmailDeliveryError("configuration_unavailable");
  if (!EMAIL_RE.test(input.to) || /[\r\n\0]/.test(input.to) || input.text.length > 20_000) throw new AuthEmailDeliveryError("invalid_request");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: config.from, to: [input.to], subject: input.subject, text: input.text }),
  });
  if (!response.ok) throw new AuthEmailDeliveryError("provider_rejected", response.status);
}

export function sendAuthEmailInBackground(input: { kind: AuthEmailKind; to: string; subject: string; text: string }) {
  const emailAttemptId = randomUUID();
  void sendAuthEmail(input).catch((error: unknown) => {
    // Keep provider details useful but allowlisted; never log recipient, content, links, or credentials.
    const failureClass = error instanceof AuthEmailDeliveryError
      ? error.failureClass
      : error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? "timeout" : "network_error";
    const providerStatus = error instanceof AuthEmailDeliveryError ? error.providerStatus : undefined;
    console.error(JSON.stringify({
      event: "customer_auth_email_failed",
      emailAttemptId,
      emailType: input.kind,
      failureClass,
      ...(providerStatus ? { providerStatus } : {}),
    }));
  });
}

export function sendCustomerWelcomeEmail(to: string, signInUrl: string) {
  sendAuthEmailInBackground({
    kind: "welcome",
    to,
    subject: "Welcome to GPHKM",
    text: `Your GPHKM account is ready. Sign in to continue:\n\n${signInUrl}\n`,
  });
}
