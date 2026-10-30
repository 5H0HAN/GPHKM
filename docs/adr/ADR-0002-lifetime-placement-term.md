# ADR-0002: Lifetime placement term and post-completion remedy

- **Status:** Accepted
- **Date:** 2026-10-27
- **Decision owners:** Product / Operations

## Context

Supplier publication sites and search platforms may change or remove a placement after GPHKM has completed an order item. An unlimited replacement promise would create an indefinite fulfillment obligation that GPHKM cannot control.

## Decision

A listing may be sold as a lifetime placement. This means the publisher intends to keep it live indefinitely. It is not a guarantee by GPHKM that the URL will remain available.

Completion requires a live URL and staff verification. After valid completion, later disappearance does not create a replacement or refund entitlement, including disappearance caused by a search/platform update. GPHKM records the known cause and explains it to the customer without inventing a cause or rewriting the original completion evidence.

A never-delivered placement, incorrect completion verification, supplier rejection, or pre-completion failure follows the item-level cancellation/refund policy in the Product Specification and Money Flow Architecture. Legal or processor-required exceptions remain available.

The listing and checkout purchase snapshot must disclose the placement term and the absence of a continued-availability guarantee.

## Consequences

- No automated monitoring or replacement workflow is needed for this promise.
- Retain completion evidence and later availability observations as separate records.
- Customer-facing copy must distinguish the publisher's intended lifetime term from a GPHKM availability guarantee.

## Revisit trigger

Revisit if GPHKM offers a time-limited guarantee, replacement service, or another post-completion remedy.
