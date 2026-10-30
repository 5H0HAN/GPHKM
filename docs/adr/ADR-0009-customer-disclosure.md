# ADR-0009: GPHKM-branded customer disclosure and status projection

- **Status:** Accepted
- **Date:** 2026-10-28
- **Decision owners:** Product / Security / Operations

## Context

Supplier identity, source classification, and reseller mechanics are internal. At the same time, order content is shared with the publication site/partner to fulfill a placement, so customers need a clear content-sharing notice and meaningful progress updates.

## Options considered

- Expose supplier names and sourcing details: unnecessary disclosure of internal commercial relationships.
- Omit mention of external content sharing: conflicts with informed consent and the approved data boundary.
- Use GPHKM-branded status language and a neutral, truthful publication-site/partner disclosure without revealing identity or sourcing details.

## Decision

- Keep catalog and customer status messaging GPHKM-branded. Do not show supplier identity, source classification, source costs, packet state, or internal handoff mechanics.
- At checkout, explain that the approved article and necessary link instructions are shared with the publication site/partner fulfilling the placement. Bind item-level consent to the content, supplier, and recipient internally; require fresh consent when those change.
- Customer milestones are Order Received, Content Review (when needed), Preparing Your Placement, Publication in Progress, Link Verification, and Complete/Resolved. Show last-updated and next-update times. For supplier email, Publication in Progress begins after provider-confirmed delivery or staff-recorded manual send; for internal fulfillment without supplier email, it begins when assigned staff records work as started.
- Customers see only customer-safe Support status/replies. Internal notes, supplier details, and Finance deliberations remain private.
- Support cases use customer-visible labels Received, In Review, Waiting on You, and Resolved; the opener receives in-app and transactional email updates. Order milestones notify the ordering Member; Owners see all order states in-app without automatic emails for each Member order.
- Customer confirms rights to submitted content. GPHKM applies platform-wide and listing-specific acceptable-content rules, with Admin review for sensitive but potentially legal topics. Do not guarantee SEO or ranking results.

## Consequences

- Customer projections must be separate from internal order, packet, and supplier state.
- Consent remains item-specific and auditable without disclosing the source classification.
- Legal review must approve final customer wording for content rights, publication-site sharing, content policy, and placement terms before sales.

## Revisit trigger

Revisit if GPHKM changes its fulfillment disclosure, exposes supplier identity, offers additional service types, or changes the customer content sharing boundary.
