export type MetricRedistributionDecision = "APPROVED" | "REVOKED";

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

export function validateMetricRedistributionDecision(input: {
  decision: unknown;
  attributionText?: unknown;
  evidenceReference: unknown;
  reason: unknown;
}): { decision: MetricRedistributionDecision; attributionText: string | null; evidenceReference: string; reason: string } {
  if (input.decision !== "APPROVED" && input.decision !== "REVOKED") throw new Error("Invalid metric decision");
  const attributionText = input.decision === "APPROVED" ? requiredText(input.attributionText, "attribution", 300) : null;
  const evidenceReference = requiredText(input.evidenceReference, "rights evidence reference", 500);
  if (evidenceReference.length < 5) throw new Error("Invalid rights evidence reference");
  const reason = requiredText(input.reason, "review reason", 1000);
  if (reason.length < 5) throw new Error("Invalid review reason");
  return { decision: input.decision, attributionText, evidenceReference, reason };
}
