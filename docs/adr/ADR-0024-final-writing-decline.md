# ADR-0024: Final writing decline returns the undelivered stage to wallet

- Status: Accepted
- Date: 2026-10-30
- Decision owners: GPHKM product owner

## Context

Customers can approve the first writing draft and finish the service, or request the one included revision and review the final draft. The product needs a clear way to stop GPHKM Writing if the customer declines that final draft without canceling the separately purchased placement.

## Decision

- Only the ordering Member may decline, and only while the final draft is awaiting customer approval before handoff.
- The writing service stops. One transaction records the stop and credits exactly the checkout-snapshotted undelivered final-stage amount to the organization wallet. A stable item-scoped idempotency key prevents duplicate credits; zero stage amounts create no ledger entry.
- The placement remains active in customer content review. The customer must submit a complete article of their own.
- Admin reviews the replacement article through the existing content-change workflow. The ordering Member must then consent to the exact approved article and current fulfillment recipient before staff can move the placement toward handoff.
- Preserve the original writing fee, drafts, and checkout snapshot. A later eligible pre-handoff cancellation refunds only the placement amount because the final writing-stage credit has already been issued.

## Consequences

- Wallet credit is an immutable `ITEM_REFUND` ledger entry. The database function checks the ordering Member, tenant, paid order, final-draft state, fulfillment cutoff, and active organization, then commits the credit and writing state atomically under the organization wallet-risk lock.
- The replacement article remains text-only and follows existing Admin assignment, audit, review, versioning, and recipient-bound consent rules.
- No supplier can receive the declined GPHKM draft as the approved article. Packet generation uses the customer replacement article only after fresh consent.
- Cancellation and Finance reconciliation continue to use the item refund ledger totals; the writing credit reduces the item’s remaining refundable placement amount.
