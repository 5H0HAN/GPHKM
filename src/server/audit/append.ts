import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { auditEvent } from "@/db/schema";

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const SAFE_METADATA_KEYS = new Set([
  "result", "fromState", "toState", "reasonCode", "itemCount", "version", "provider", "providerEventId", "policyVersion", "amountMinor",
  "listingId", "observationId", "decision",
]);

export type AuditMetadata = Record<string, string | number | boolean | null>;

function safeMetadata(metadata: AuditMetadata | undefined): Record<string, string | number | boolean | null> {
  if (!metadata) return {};
  return Object.fromEntries(Object.entries(metadata).filter(([key, value]) =>
    SAFE_METADATA_KEYS.has(key) && (value === null || ["string", "number", "boolean"].includes(typeof value))));
}

export async function appendAuditEvent(tx: DbTransaction, input: {
  organizationId?: string | null;
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  reasonCode?: string | null;
  correlationId?: string | null;
  metadata?: AuditMetadata;
}): Promise<void> {
  await tx.insert(auditEvent).values({
    id: randomUUID(),
    organizationId: input.organizationId ?? null,
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    reasonCode: input.reasonCode ?? null,
    correlationId: input.correlationId ?? null,
    metadata: safeMetadata(input.metadata),
  });
}
