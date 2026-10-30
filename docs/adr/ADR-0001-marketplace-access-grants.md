# ADR-0001: Organization marketplace access grants

- **Status:** Accepted
- **Date:** 2026-10-27
- **Decision owners:** Product / Engineering / Security

## Context

Customer accounts, wallets, and orders belong to organizations. Marketplace browsing begins with a limited trial; URL visibility is a separate restriction. Wallet balance and browsing entitlement are separate benefits.

## Decision

Each organization receives 15 days of marketplace browsing from its creation time. Listing URLs remain hidden by default during the trial. An audited per-listing public-URL setting may reveal that URL while the organization is otherwise allowed to browse.

After trial expiry, catalog browsing requires an active paid access grant. One settled top-up whose wallet credit is at least the configured minimum creates a grant immediately at settlement. The initial minimum is $50 USD. The global duration policy supports six calendar months, one year, or unrestricted access; the initial setting is six calendar months. Future policy changes apply only to future grants; every grant snapshots the policy version and interval.

The grant is independent of wallet spending. Each qualifying top-up creates its own grant under the policy active at settlement. With finite grants, the new interval starts at the later of the latest recorded finite expiry or settlement. Calculate calendar terms in UTC and clamp month-end dates to the last valid day (for example, six months from August 31 ends on the last day of February). If an unrestricted grant is already active, a new grant starts at settlement under the current policy and does not change that grant or any other interval. Each grant retains its recorded interval if another grant is suspended or revoked; access may have a gap until a later grant's recorded interval begins. Never move another grant to close a gap.

A payment dispute suspends only its linked grant. A verified loss, refund, or reversal revokes only the affected grant. A verified dispute win restores that grant with its original expiry; time continues to run while it is suspended. Replaying the same funding event cannot duplicate or extend a grant.

A public-URL setting bypasses URL concealment only. It never bypasses sign-in or the browse gate. Expired organizations may still access profile, settings, wallet/recharge history, existing orders, and support.

## Consequences

- Access is evaluated server-side from the active organization, trial timestamps, and grant intervals/status.
- Unauthorized catalog rows and URLs are omitted from responses, search, metadata, hydration, prefetch, exports, analytics, and caches.
- The countdown is display-only and uses server timestamps.
- This is a narrow entitlement record, not a subscription or general policy engine.

## Revisit trigger

Revisit only if the business adopts subscriptions, per-user entitlements, promotions that grant access, or materially different billing/access rules.
