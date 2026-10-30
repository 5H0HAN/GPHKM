# ADR-0004: Lock order retail price and track supplier cost variance

- **Status:** Accepted
- **Date:** 2026-10-27
- **Decision owners:** Product / Finance / Operations

## Context

Supplier source costs may change after a customer places an order. Repricing that order would break the customer's accepted checkout terms. Future listings still need prices that preserve the intended gross margin.

## Decision

The customer retail price snapshot is fixed when the order is confirmed and wallet-debited. A later supplier source-cost change does not change the customer's charge or wallet refund amount for that item.

Record the confirmed actual direct cost against the order item. If the cost is not yet known, keep it explicitly unknown and mark gross-profit results provisional. The actual cost may change the realized margin on that existing order. Listing retail-price changes apply to future orders and can restore the intended margin.

A substitute that changes the customer-facing publication terms or destination requires explicit customer approval. Do not silently reprice or alter an existing order. If no acceptable equivalent can meet the purchased customer-facing terms, resolve only that item under the cancellation/refund policy. A source-cost change alone does not reprice or invalidate the existing order.

## Consequences

- Order snapshots remain stable across later listing and source-cost changes.
- Margin reports distinguish estimated/unknown cost from confirmed actual cost and audited correction.
- Staff cannot charge a customer more for an existing order without a separately approved and disclosed policy.

## Revisit trigger

Revisit if the product introduces customer-approved order change orders or variable post-purchase pricing.
