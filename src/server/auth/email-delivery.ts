import "server-only";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function configuration() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  const address = /<([^<>]+)>/.exec(from ?? "")?.[1] ?? from;
  if (process.env.GPHKM_RESEND_DATA_HANDLING_APPROVED !== "true" || !apiKey || !from || !address || !EMAIL_RE.test(address) || /[\r\n\0]/.test(from)) return null;
  return { apiKey, from };
}

export function customerAuthEmailAvailable() {
  return configuration() !== null;
}

export async function sendCustomerAuthEmail(input: { to: string; subject: string; text: string }) {
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

export function sendCustomerAuthEmailInBackground(input: { to: string; subject: string; text: string }) {
  void sendCustomerAuthEmail(input).catch(() => {
    // Never log email addresses, tokens, message bodies, or provider secrets.
    console.error(JSON.stringify({ event: "customer_auth_email_failed" }));
  });
}
