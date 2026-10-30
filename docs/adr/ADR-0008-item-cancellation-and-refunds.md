# ADR-0008: Item cancellation, writing-stage refunds, and handoff cutoffs

- **Status:** Accepted
- **Date:** 2026-10-28
- **Decision owners:** Product / Operations / Finance

## Context

Orders contain independent items and may include GPHKM Writing. Supplier work may begin when a packet is accepted by an email provider or manually sent; internal fulfillment has no supplier email. Cancellation timing and refund authority must be explicit to avoid duplicate work, inconsistent credits, or silent price changes.

## Options considered

- Cancel freely until publication: risks cancellation after a supplier or writer has begun work.
- Disallow all cancellation after checkout: prevents reasonable cancellation before work starts.
- Use a fulfillment cutoff, rule-based pre-cutoff wallet credits, and reviewed exceptions after cutoff.

## Decision

- Before the applicable cutoff, a customer may request cancellation of an individual item. The assigned Admin reviews it and may approve it under the published item policy. The system computes an exact wallet credit; no external payment refund is implied.
- For supplier email, handoff/cancellation cutoff is provider acceptance or staff-recorded manual send. Packet preparation or export alone is not handoff. A later delivery failure does not reopen ordinary cancellation; use the Support exception path.
- For platform/internal fulfillment without supplier email, the cutoff is the assigned staff member's recorded fulfillment start.
- After the cutoff, customer cancellation/refund is not allowed by default. Admin investigates a documented order-item Support case; Finance or Super Admin may approve an item-specific wallet exception after reviewing evidence. Supplier failure is not an automatic refund. Legal/processor-required remedies remain available.
- Placement price and optional writing fee are separate checkout snapshots. Each writing listing discloses two Admin-set stage amounts: complete first draft delivered and final draft delivered after the included revision. If the customer approves the first draft without requesting a revision, approval completes both stages. Delivered stages are earned; only undelivered stage amounts may be credited under the disclosed policy.
- Minimal Support case states are Open, Investigating, Waiting on Customer/Supplier, Finance Review, and Resolved/Closed. Item, packet, and customer-visible states remain separate.

## Consequences

- Handoff state and cancellation eligibility must be derived from durable provider/manual send evidence or an internal work-start event, not a button click alone.
- Pre-cutoff cancellation credits must be idempotent, bounded to the purchased component amounts, and audited.
- Writing listings cannot be published until their stage values, price, turnaround, and policy are disclosed.
- Post-cutoff exceptions require a Support case and Finance/Super Admin review; this is not a full ticketing platform.

## Revisit trigger

Revisit if GPHKM introduces a standard post-handoff cancellation window, external payment refunds, supplier-backed cancellation guarantees, or a different writing deliverable schedule.
