import { parseUsdMinorUnits } from "./usd-amount.ts";

export const ACCESS_DURATIONS = ["SIX_MONTHS", "ONE_YEAR", "UNRESTRICTED"] as const;
export type AccessDuration = (typeof ACCESS_DURATIONS)[number];

export function parseAccessPolicyUpdate(input: { minimumUsd: string; duration: string; reason: string }) {
  const minimumMinor = parseUsdMinorUnits(input.minimumUsd.trim());
  if (!ACCESS_DURATIONS.includes(input.duration as AccessDuration)) throw new Error("Invalid access duration");
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new Error("Provide a 10–500 character reason without control characters");
  }
  return { minimumMinor: minimumMinor.toString(), duration: input.duration as AccessDuration, reason };
}
