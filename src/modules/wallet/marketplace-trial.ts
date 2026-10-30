export const MARKETPLACE_TRIAL_DURATION_MS = 15 * 24 * 60 * 60 * 1000;

export function marketplaceTrialEndsAt(organizationCreatedAt: Date): Date {
  return new Date(organizationCreatedAt.getTime() + MARKETPLACE_TRIAL_DURATION_MS);
}

export function isMarketplaceTrialActive(organizationCreatedAt: Date, now: Date): boolean {
  return now.getTime() < marketplaceTrialEndsAt(organizationCreatedAt).getTime();
}

export function marketplaceTrialCountdown(trialEndsAt: Date, now: number): {
  days: number;
  hours: number;
  minutes: number;
  expired: boolean;
} {
  const remaining = Math.max(0, trialEndsAt.getTime() - now);
  return {
    days: Math.floor(remaining / 86_400_000),
    hours: Math.floor((remaining % 86_400_000) / 3_600_000),
    minutes: Math.floor((remaining % 3_600_000) / 60_000),
    expired: remaining === 0,
  };
}
