import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedInvitationToken = Readonly<{ ciphertext: string; nonce: string; tag: string }>;

function encryptionKey(env: Record<string, string | undefined> = process.env): Buffer {
  const encoded = env.GPHKM_INVITATION_TOKEN_ENCRYPTION_KEY;
  if (!encoded || !/^[a-fA-F0-9]{64}$/.test(encoded)) {
    throw new Error("Invitation token encryption is unavailable");
  }
  return Buffer.from(encoded, "hex");
}

export function assertInvitationTokenEncryptionConfigured(env: Record<string, string | undefined> = process.env): void {
  encryptionKey(env);
}

export function encryptInvitationToken(token: string, context: string, env?: Record<string, string | undefined>): EncryptedInvitationToken {
  if (!/^(ORGANIZATION|STAFF):[0-9a-f-]{36}$/i.test(context)) throw new Error("Invitation encryption context is invalid");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(env), nonce);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptInvitationToken(value: EncryptedInvitationToken, context: string, env?: Record<string, string | undefined>): string {
  if (!/^(ORGANIZATION|STAFF):[0-9a-f-]{36}$/i.test(context)) throw new Error("Invitation encryption context is invalid");
  const nonce = Buffer.from(value.nonce, "base64url");
  const tag = Buffer.from(value.tag, "base64url");
  const ciphertext = Buffer.from(value.ciphertext, "base64url");
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length < 32 || ciphertext.length > 128) {
    throw new Error("Encrypted invitation token is invalid");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(env), nonce);
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tag);
  const token = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) throw new Error("Decrypted invitation token is invalid");
  return token;
}
