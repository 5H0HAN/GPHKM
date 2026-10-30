export type GrantDuration = "SIX_MONTHS" | "ONE_YEAR" | "UNRESTRICTED";
export type RecordedGrant = {
  startsAt: Date;
  endsAt: Date | null;
  state: "ACTIVE" | "SUSPENDED" | "REVOKED";
};

export function addUtcCalendarMonthsClamped(value: Date, months: number): Date {
  if (!Number.isInteger(months) || months < 0) throw new Error("Invalid month count");
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = month % 12;
  const day = Math.min(value.getUTCDate(), new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate());
  return new Date(Date.UTC(targetYear, targetMonth, day, value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), value.getUTCMilliseconds()));
}

export function createGrantInterval(input: {
  settledAt: Date;
  creditedMinor: bigint;
  minimumMinor: bigint;
  duration: GrantDuration;
  existing: readonly RecordedGrant[];
}): { startsAt: Date; endsAt: Date | null } {
  if (input.creditedMinor < input.minimumMinor) throw new Error("Credit does not qualify for marketplace access");
  if (!Number.isFinite(input.settledAt.getTime())) throw new Error("Invalid settlement time");
  if (input.duration === "UNRESTRICTED") return { startsAt: new Date(input.settledAt), endsAt: null };

  const hasActiveUnrestricted = input.existing.some((grant) =>
    grant.endsAt === null && grant.state === "ACTIVE" && grant.startsAt <= input.settledAt,
  );
  const latestFiniteExpiry = input.existing.reduce<Date | null>((latest, grant) => {
    if (!grant.endsAt) return latest;
    return latest === null || grant.endsAt > latest ? grant.endsAt : latest;
  }, null);
  const startsAt = hasActiveUnrestricted || !latestFiniteExpiry || input.settledAt > latestFiniteExpiry
    ? new Date(input.settledAt)
    : new Date(latestFiniteExpiry);
  const months = input.duration === "SIX_MONTHS" ? 6 : 12;
  return { startsAt, endsAt: addUtcCalendarMonthsClamped(startsAt, months) };
}

export function hasMarketplaceAccess(grants: readonly RecordedGrant[], now: Date): boolean {
  return grants.some((grant) => grant.state === "ACTIVE" && grant.startsAt <= now && (grant.endsAt === null || now < grant.endsAt));
}
