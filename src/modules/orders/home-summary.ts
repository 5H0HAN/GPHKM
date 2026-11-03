export function customerHomeTimestampIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date
    ? value
    : typeof value === "string" ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) throw new Error("Customer activity timestamp is unavailable");
  return date.toISOString();
}
