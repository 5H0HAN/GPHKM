const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_NUMERIC_20 = 10n ** 20n - 1n;

export function validatePostHandoffRefundRequest(input: { caseId: string; idempotencyKey: string; amountMinor: string; reason: string }) {
  return { caseId: identity(input.caseId), idempotencyKey: identity(input.idempotencyKey), amountMinor: minor(input.amountMinor, false), reason: text(input.reason, 2000, 5) };
}

export function validatePostHandoffRefundDecision(input: {
  requestId: string; decision: string; amountMinor: string; idempotencyKey: string; reason: string;
}) {
  const requestId = identity(input.requestId);
  const idempotencyKey = identity(input.idempotencyKey);
  const reason = text(input.reason, 1000, 5);
  if (input.decision !== "APPROVED" && input.decision !== "DENIED") throw new Error("Invalid refund decision");
  const amountMinor = minor(input.amountMinor, input.decision === "DENIED");
  if (input.decision === "APPROVED" && amountMinor === "0") throw new Error("Approved refund amount must be positive");
  if (input.decision === "DENIED" && amountMinor !== "0") throw new Error("Denied refund must have a zero amount");
  return { requestId, decision: input.decision, amountMinor, idempotencyKey, reason } as const;
}

function identity(value: string) {
  if (!UUID.test(value)) throw new Error("Refund request is unavailable");
  return value;
}

function minor(value: string, allowZero: boolean) {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error("Refund amount must use exact USD minor units");
  const amount = BigInt(value);
  if (amount > MAX_NUMERIC_20 || (!allowZero && amount === 0n)) throw new Error("Refund amount is outside the allowed range");
  return amount.toString();
}

function text(value: string, max: number, min: number) {
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new Error("Refund reason is invalid");
  }
  return normalized;
}
