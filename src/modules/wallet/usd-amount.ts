const USD_AMOUNT = /^(0|[1-9][0-9]{0,14})(?:\.([0-9]{1,2}))?$/;
// Keep every minor-unit amount exactly representable in JavaScript's safe integer range.
const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

export function parseUsdMinorUnits(value: string): bigint {
  const match = USD_AMOUNT.exec(value);
  if (!match) throw new Error("Enter a valid USD amount with up to two decimal places");
  const dollars = BigInt(match[1]);
  const cents = BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  const amount = dollars * 100n + cents;
  if (amount <= 0n || amount > MAX_MINOR) throw new Error("USD amount is outside the allowed range");
  return amount;
}

export function formatUsdMinorUnits(amount: bigint): string {
  if (amount < 0n || amount > MAX_MINOR) throw new Error("USD amount is outside the allowed range");
  const dollars = amount / 100n;
  const cents = (amount % 100n).toString().padStart(2, "0");
  return `${dollars}.${cents}`;
}
