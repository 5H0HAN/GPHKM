import test from "node:test";
import assert from "node:assert/strict";
import { addUtcCalendarMonthsClamped, createGrantInterval, hasMarketplaceAccess } from "../src/modules/wallet/access-grants.ts";
import { formatUsdMinorUnits, parseUsdMinorUnits } from "../src/modules/wallet/usd-amount.ts";
import { isMarketplaceTrialActive, marketplaceTrialCountdown, marketplaceTrialEndsAt } from "../src/modules/wallet/marketplace-trial.ts";

test("USD amounts use exact minor units and reject ambiguous input", () => {
  assert.equal(parseUsdMinorUnits("50"), 5000n);
  assert.equal(parseUsdMinorUnits("0.5"), 50n);
  assert.equal(formatUsdMinorUnits(5000n), "50.00");
  for (const value of ["", "-1", "+1", "1e2", "1.001", "01.00", "0"]) assert.throws(() => parseUsdMinorUnits(value));
});

test("calendar months clamp month ends in UTC", () => {
  assert.equal(addUtcCalendarMonthsClamped(new Date("2026-08-31T12:30:00Z"), 6).toISOString(), "2027-02-28T12:30:00.000Z");
});

test("qualifying grants extend recorded finite intervals without moving prior grants", () => {
  const settledAt = new Date("2026-08-31T12:30:00Z");
  const existing = [{ startsAt: new Date("2026-08-31T12:30:00Z"), endsAt: new Date("2027-02-28T12:30:00Z"), state: "ACTIVE" }];
  assert.deepEqual(createGrantInterval({ settledAt, creditedMinor: 5000n, minimumMinor: 5000n, duration: "SIX_MONTHS", existing }), {
    startsAt: new Date("2027-02-28T12:30:00Z"), endsAt: new Date("2027-08-28T12:30:00Z"),
  });
  assert.throws(() => createGrantInterval({ settledAt, creditedMinor: 4999n, minimumMinor: 5000n, duration: "SIX_MONTHS", existing }));
});

test("an active unrestricted grant does not move and each qualifying top-up creates its own grant", () => {
  const settledAt = new Date("2026-10-28T10:00:00Z");
  const existing = [{ startsAt: new Date("2026-01-01T00:00:00Z"), endsAt: null, state: "ACTIVE" }];
  const next = createGrantInterval({ settledAt, creditedMinor: 5000n, minimumMinor: 5000n, duration: "SIX_MONTHS", existing });
  assert.deepEqual(next, { startsAt: settledAt, endsAt: new Date("2027-04-28T10:00:00Z") });
  assert.equal(hasMarketplaceAccess(existing, settledAt), true);
});

test("suspended and revoked grants do not authorize browsing", () => {
  const now = new Date("2026-10-28T10:00:00Z");
  assert.equal(hasMarketplaceAccess([{ startsAt: new Date("2026-01-01Z"), endsAt: null, state: "SUSPENDED" }], now), false);
  assert.equal(hasMarketplaceAccess([{ startsAt: new Date("2026-01-01Z"), endsAt: null, state: "REVOKED" }], now), false);
});

test("15-day marketplace trial uses one exact expiry for browse, checkout, and countdown", () => {
  const createdAt = new Date("2026-10-01T12:00:00.000Z");
  const expiresAt = marketplaceTrialEndsAt(createdAt);
  assert.equal(expiresAt.toISOString(), "2026-10-16T12:00:00.000Z");
  assert.equal(isMarketplaceTrialActive(createdAt, new Date(expiresAt.getTime() - 1)), true);
  assert.equal(isMarketplaceTrialActive(createdAt, expiresAt), false);
  assert.deepEqual(marketplaceTrialCountdown(expiresAt, expiresAt.getTime() - 90_000), {
    days: 0, hours: 0, minutes: 1, expired: false,
  });
  assert.deepEqual(marketplaceTrialCountdown(expiresAt, expiresAt.getTime()), {
    days: 0, hours: 0, minutes: 0, expired: true,
  });
});
