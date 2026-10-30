import "server-only";
import { createHash, randomBytes } from "node:crypto";

export function createInvitationSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInvitationSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function invitationExpiry(createdAt = new Date()): Date {
  return new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);
}
