import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyResendWebhook(input: { body: string; eventId: string | null; timestamp: string | null; signature: string | null; secret: string; now?: number }): boolean {
  const { body, eventId, timestamp, signature, secret } = input;
  if (!eventId || !/^[-A-Za-z0-9_]+$/.test(eventId) || !timestamp || !/^\d{10}$/.test(timestamp) || !signature || !secret.startsWith("whsec_")) return false;
  const sentAt = Number(timestamp) * 1000;
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(sentAt) || Math.abs(now - sentAt) > 5 * 60 * 1000) return false;
  let key: Buffer;
  try { key = Buffer.from(secret.slice(6), "base64"); } catch { return false; }
  if (!key.length) return false;
  const expected = createHmac("sha256", key).update(`${eventId}.${timestamp}.${body}`).digest();
  const candidates = signature.split(/\s+/).filter((part) => part.startsWith("v1,")).map((part) => {
    try { return Buffer.from(part.slice(3), "base64"); } catch { return Buffer.alloc(0); }
  });
  return candidates.some((candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected));
}
