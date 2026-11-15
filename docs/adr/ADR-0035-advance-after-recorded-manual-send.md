# ADR-0035: Advance placement after a recorded manual supplier send

**Status:** Accepted
**Date:** 2026-11-11

## Context

The accepted provider email may remain undelivered or unclear while an operator can send the exact, consent-bound packet from their mail client. The existing flow required a second supplier-receipt acknowledgement before customer progress advanced, even after staff attested to the actual manual send. This left a correctly handed-off order at Preparing and made the manual fallback difficult to operate.

## Decision

- Provider-confirmed delivery or an assigned staff member's recorded actual manual send advances eligible items from HANDOFF_PENDING / Preparing to IN_FULFILLMENT / Publication in Progress.
- A reservation, EML/PDF export, or intent to send does not advance the stage. Staff must attest to the exact recipient, actual send time, message reference, and that the complete packet was sent.
- Supplier receipt acknowledgement remains a separate append-only fact. Recording it does not advance or change the customer stage.
- Preserve the first handoff/cancellation cutoff. A later provider delivery event may reconcile the original attempt but does not move an item backwards or duplicate the workflow transition.
- The database checks that the manual attempt belongs to the latest, current-route packet and has MANUAL_SENT state and sent_at before permitting work to start.

## Consequences

- Manual send recording and stage advancement happen atomically in the same transaction, with both the packet attempt event and fulfillment transition audited.
- Late provider events remain separately recorded; duplicate delivery is an accepted outcome and does not undo manual progress.
- Supplier acknowledgement follow-up remains a separate operations task. Publication completion still requires a live URL and staff verification.
- This supersedes ADR-0032's requirement to wait for supplier receipt before manually handed-off work can advance, and updates the supplier-email milestone rule from ADR-0009.
