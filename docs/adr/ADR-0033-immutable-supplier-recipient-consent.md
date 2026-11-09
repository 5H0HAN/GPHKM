# ADR-0033: Keep checkout recipient consent in a private immutable snapshot

- **Status:** Accepted
- **Date:** 2026-11-03
- **Decision owners:** Product / Security / Operations

## Context

Customers agree that GPHKM may share approved order content with the publication partner, while GPHKM keeps supplier identity and contact details private. A packet must still be bound to the exact supplier and primary email that were current when the customer gave that consent. Looking up the current email later could otherwise reuse old consent after a contact change.

## Decision

- When the order-time supplier route is created, capture the active supplier's primary email, supplier ID, consent notice version, and acceptance time in a separate immutable table with RLS enabled and no application-role read grants.
- Packet database guards accept base checkout consent only when the captured supplier and recipient still match the current route and primary contact. A new content-version consent may authorize a new supplier or recipient only when its exact consent event, version, route, and current recipient all match.
- After provider acceptance, a same-supplier recipient change may be retried only when the send was reconciled as definitely not delivered, no publication work or delivery evidence exists, and no manual/export/acknowledgement or unresolved evidence exists. A Super Admin creates an audited re-consent version from the immutable prior packet content; only the actual orderer can approve that version for the current contact. The original cancellation cutoff and Preparing milestone remain unchanged. Replacement is complete-packet and Resend-only; guards recheck evidence at preparation and send reservation.
- Keep listing placement requirements bound to the immutable order terms, or to the customer-accepted equivalent terms when an equivalent offer is used.
- Backfill legacy rows only when the current primary contact record existed at checkout and has not been updated since. Other legacy rows require the customer to consent to a current content version before packet preparation.

## Consequences

- A supplier contact change does not silently redirect approved customer content to a new email address.
- A delivery issue does not restore ordinary cancellation eligibility or silently re-send. A narrowly scoped retry requires a new orderer consent event for the exact current recipient and unchanged content.
- Supplier recipient data remains private and separate from customer-readable order projections.
- Any order-time supplier fulfillment route requires one active primary contact. Missing-contact listings fail closed instead of producing an order that cannot be handed off.
- The extra consent record is an order-time receipt, not a supplier portal or separate service.
