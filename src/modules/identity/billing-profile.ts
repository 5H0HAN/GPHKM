export type BillingProfileInput = {
  legalName: string;
  billingEmail: string;
  billingAddress: string;
};

export function normalizeBillingProfile(input: BillingProfileInput) {
  const optionalText = (value: string, max: number, field: string) => {
    const normalized = value.trim();
    if (!normalized) return null;
    if (normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`Invalid ${field}`);
    return normalized;
  };
  const legalName = optionalText(input.legalName, 160, "legal name");
  const billingAddress = optionalText(input.billingAddress, 1000, "billing address");
  const rawEmail = optionalText(input.billingEmail, 254, "billing email");
  const billingEmail = rawEmail?.toLowerCase() ?? null;
  if (billingEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingEmail)) throw new Error("Invalid billing email");
  return { legalName, billingEmail, billingAddress };
}
