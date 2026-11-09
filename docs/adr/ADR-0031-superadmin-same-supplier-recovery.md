# ADR-0031: Audited Super Admin same-supplier recovery

- **Status:** Accepted
- **Date:** 2026-11-03
- **Decision owners:** Product / Engineering / Security

## Context

A supplier may later confirm availability after an item has been placed on hold for that supplier's failure. Requiring a different listing in every case can force unnecessary customer reapproval even when the purchased route and terms have not changed. A direct status override would erase the distinction between the old failure and the new availability evidence, and could bypass packet, consent, or handoff checks.

## Decision

An active Super Admin may record renewed availability for the same supplier on the current route generation when all of these conditions hold:

- The Super Admin is currently assigned to the item.
- The paid order item remains on hold and has no handoff or internal work-start cutoff.
- The current supplier is active and has a primary contact.
- Every unresolved failure for the item belongs to that same supplier, route generation, and active order Support case.
- There is no pending equivalent offer and no prior supplier packet attempt, including an export, reservation, unknown send, or manual send.

The command requires a bounded internal reason. It writes a new immutable recovery event and links every matching unresolved failure outcome to that recovery without changing or deleting the earlier outcome. The Support case remains open; an internal note and neutral customer-visible reply are appended in the same transaction. The item and its customer milestone remain on hold until the assigned staff member resumes the saved workflow.

Recovery does not prepare or send a packet. The normal packet path rechecks the current approved content, supplier route, primary recipient, and sharing consent before preparation and again before any send/export/manual handoff attempt. Attempt insertion is denied while any packet item is still on hold, and the database validates that each historical failure has a valid accepted-route or recovery resolution. A later route change does not erase the recovery history.

If a packet attempt or handoff has already occurred, the system does not use this recovery path; staff must reconcile the actual outcome and use the approved customer decision, accepted equivalent, or cancellation/refund workflow.

## Consequences

- The previous failure remains visible in item and Support history; recovery is an explicit, separately attributed action.
- A customer receives a status-safe Support update without supplier identity, sourcing, or internal reason.
- Same-supplier recovery does not change checkout terms or route generation and cannot bypass the item hold.
- Idempotency, least privilege, append-only records, database-enforced route/case checks, and current packet validation protect retries and concurrent changes.

## Revisit trigger

Revisit if operational evidence shows the no-prior-packet-attempt rule blocks a frequent safe case, or if customer consent policy changes to bind the original supplier's named recipient explicitly.
