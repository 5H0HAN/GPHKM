import "server-only";
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

export async function sendAuthEmail(input: { to: string; subject: string; text: string }) {
  const config = configuration();
  if (!config || !EMAIL_RE.test(input.to) || /[\r\n\0]/.test(input.to) || input.text.length > 20_000) {
    throw new Error("Customer authentication email is unavailable");
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: config.from, to: [input.to], subject: input.subject, text: input.text }),
  });
  if (!response.ok) throw new Error("Customer authentication email delivery failed");
}

export function sendAuthEmailInBackground(input: { to: string; subject: string; text: string }) {
  void sendAuthEmail(input).catch(() => {
    // Never log email addresses, tokens, message bodies, or provider secrets.
    console.error(JSON.stringify({ event: "customer_auth_email_failed" }));
  });
}
