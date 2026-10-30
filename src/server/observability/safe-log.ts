import "server-only";

const SAFE_CORRELATION_FIELDS = new Set([
  "actorId", "organizationId", "orderId", "paymentAttemptId", "providerEventId", "importBatchId", "permission", "reasonCode", "surface",
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
  const candidate = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  const errorCode = typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate) ? candidate : undefined;
  const errorType = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name) ? error.name : "UnknownError";
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(), level: "error", event, requestId, errorType,
    ...safeCorrelationFields(context),
    ...(errorCode ? { errorCode } : {}),
  }));
}
