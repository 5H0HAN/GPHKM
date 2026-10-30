import "server-only";

const SAFE_CORRELATION_FIELDS = new Set([
  "actorId", "organizationId", "orderId", "paymentAttemptId", "providerEventId", "importBatchId", "permission", "reasonCode", "surface",
]);
const SAFE_DATABASE_REASONS = new Set([
  "order unavailable", "marketplace access required", "order totals or item count invalid",
  "listing is unavailable or order snapshot is invalid", "listing source unavailable",
  "wallet unavailable", "insufficient available wallet balance", "checkout idempotency already consumed",
]);

export function safeCorrelationFields(context: Record<string, unknown> = {}): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (SAFE_CORRELATION_FIELDS.has(key) && typeof value === "string" && value.length <= 128
      && /^[A-Za-z0-9._:-]+$/.test(value)) fields[key] = value;
  }
  return fields;
}

export function logSafeEvent(event: string, requestId: string, context: Record<string, unknown> = {}): void {
  if (!/^[a-z][a-z0-9_]{1,79}$/.test(event) || !/^[A-Za-z0-9-]{8,80}$/.test(requestId)) return;
  console.warn(JSON.stringify({
    timestamp: new Date().toISOString(), level: "warn", event, requestId,
    ...safeCorrelationFields(context),
  }));
}

export function logSafeFailure(event: string, error: unknown, requestId: string, context: Record<string, unknown> = {}): void {
  if (!/^[a-z][a-z0-9_]{1,79}$/.test(event) || !/^[A-Za-z0-9-]{8,80}$/.test(requestId)) return;
  let candidate: unknown;
  const databaseLocation: Record<string, string> = {};
  let databaseReason: string | undefined;
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const details = current as Record<string, unknown>;
    if (!candidate && typeof details.code === "string" && /^[0-9A-Z]{5}$/.test(details.code)) candidate = details.code;
    if (!databaseReason && typeof details.message === "string" && SAFE_DATABASE_REASONS.has(details.message)) databaseReason = details.message;
    for (const key of ["routine", "table", "column", "constraint"] as const) {
      const value = details[key];
      if (typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value)) databaseLocation[key] = value;
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  const errorCode = typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate) ? candidate : undefined;
  const errorType = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name) ? error.name : "UnknownError";
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(), level: "error", event, requestId, errorType,
    ...safeCorrelationFields(context),
    ...(errorCode ? { errorCode } : {}),
    ...(Object.keys(databaseLocation).length ? { databaseLocation } : {}),
    ...(databaseReason ? { databaseReason } : {}),
  }));
}
