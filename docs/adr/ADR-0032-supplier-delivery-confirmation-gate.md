# ADR-0032: Supplier delivery confirmation gates placement progress

**Status:** Accepted
**Date:** 2026-11-03

## Context

The customer milestone must remain Preparing after a supplier email is accepted or staff records an external manual send. Both events set the handoff/cancellation cutoff, but neither alone confirms that the supplier received the packet. Provider-confirmed delivery is available for GPHKM sends. For manual sends, staff records the supplier's receipt acknowledgement as the delivery evidence.

The previous implementation advanced manually sent items to Publication in Progress immediately and allowed a MANUAL_SENT attempt by itself to satisfy the database work-start guard. Generic fulfillment actions could also enter HANDOFF_PENDING without creating a supplier packet.

## Decision

- Supplier packet preparation is the only transition from READY_FOR_HANDOFF to HANDOFF_PENDING and sets the customer status to PREPARING in the same transaction.
- Provider acceptance and an actual recorded manual send set the permanent handoff cutoff and leave supplier-backed items in HANDOFF_PENDING / PREPARING.
- Provider-confirmed delivery advances eligible current-route items to IN_FULFILLMENT / IN_PROGRESS.
- A manual send advances eligible current-route items only after staff records supplier receipt against the same packet and attempt. The acknowledgement remains append-only and idempotent per packet.
- Acknowledgement of a superseded or stale-route packet is retained as history but cannot advance current work.
- Server commands and PostgreSQL enforce the same packet, route-generation, delivery, and matching-acknowledgement conditions.

## Consequences

Manual acknowledgement uses packet → sorted item rows → attempt lock order. Provider acknowledgement retains attempt → assignment-row ordering because webhook processing may hold the attempt while updating items. A stale/manual send cannot start work by itself, and a generic status update cannot bypass packet preparation. The assigned staff member must record receipt before customer progress changes on a manual path.

The 72-hour supplier acknowledgement follow-up is an internal target. It does not promise a response time and remains separate from the handoff cutoff.
