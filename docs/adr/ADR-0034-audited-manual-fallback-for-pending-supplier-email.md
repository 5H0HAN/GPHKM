# ADR-0034: Allow an audited manual fallback while provider delivery is pending

- **Status:** Accepted
- **Date:** 2026-11-11
- **Decision owners:** Product / Engineering / Operations

## Context

Supplier packet email can fail, stall, or remain accepted without delivery confirmation. The previous workflow blocked staff from starting a manual email until the provider outcome had been reconciled or delivery was confirmed failed. That left the supplier handoff stalled even when an operator could send the reviewed packet from their mail client.

## Options considered

- Continue blocking all manual handoffs until the provider outcome is resolved. This avoids duplicate email but can delay fulfillment.
- Allow an audited manual handoff in parallel with a pending provider attempt. This can produce duplicate email but gives staff a direct recovery path while preserving evidence.

## Decision

- An assigned Admin or Super Admin may start a separate manual handoff while the latest provider attempt is SENDING, UNKNOWN, ACCEPTED without delivery, or in DELIVERY_ISSUE.
- Require a staff reason whenever a provider or prior manual send attempt already exists. Keep the provider attempt unchanged and open for later reconciliation; record the manual send as its own attempt.
- A single pending manual reservation blocks another manual reservation and ordinary cancellation until staff records the actual send or resolves it as not sent.
- Duplicate delivery from the later provider event is an accepted operational outcome. Do not mark an email sent when staff only reserved a handoff or downloaded an EML/PDF.
- A recorded manual send advances eligible placements to Publication in Progress; supplier receipt acknowledgement is recorded separately.
- Preserve the recipient-consent recovery rule: replacement packets for a changed recipient after confirmed non-delivery remain Resend-only; manual send and exports remain unavailable for that special retry.
- Provider retries remain blocked while their SENDING/UNKNOWN outcome is unresolved. Manual fallback is the explicit alternate route.

## Consequences

- Migration 0192 updates the database work-start guard to accept a recorded manual attempt for the current packet. ADR-0035 defines when that event advances customer progress.
- The packet page must explain that Resend may still deliver and provide one clear manual action for pending and failed outcomes.
- The reconciliation queue continues to track the provider attempt until its eventual result is reconciled. Late provider delivery can advance a placement normally; it does not erase manual history.
- Staff must record the actual recipient, local-offset send time, message reference, and complete-packet confirmation. A reservation or export alone does not advance the order.

## Revisit trigger

Revisit if duplicate handoffs cause material supplier confusion or if provider APIs add reliable cancellation/lookup that makes immediate manual fallback unnecessary.
