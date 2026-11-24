# ADR-0041: Persist the shared organization cart

- **Status:** Accepted
- **Date:** 2026-11-24
- **Decision owners:** Product / Engineering / Security

## Context

Customers need unfinished placements and their text to survive page navigation, refresh, and sign-out. The product owner confirmed that one cart is shared by the organization and that items included in a successful order should be cleared automatically. Because drafts may contain article text and writing briefs, the storage boundary and visibility must be explicit.

## Options considered

- Keep the cart in browser state or local storage. This would not reliably share it across organization members, devices, or sign-out and would place draft content in client storage.
- Persist one cart per customer. This would survive sessions but conflict with the approved organization sharing behavior.
- Persist one cart per organization in PostgreSQL, scoped to current membership and protected with RLS and optimistic versions.

## Decision

Store at most 25 placement drafts per organization in a dedicated PostgreSQL cart table. Active Owners and Members may read and edit it. The customer application rechecks current organization membership on each read or mutation, and PostgreSQL RLS scopes rows to the trusted organization and user transaction context.

Cart content is visible to every active organization Owner and Member. The interface states that article text, briefs, and other placement details are shared. Checkout consent is not saved in the cart. Items are retained across navigation, refresh, and sign-out until removed, cleared, included in a successful order, or the organization is deleted. Draft retention periods outside this cart behavior remain subject to L-09.

Cart mutations use a transaction-scoped organization lock and item versions to detect conflicting edits. Checkout verifies that submitted data matches the current saved item versions while holding the same cart lock. The successful order debit, audit record, and removal of submitted cart items commit atomically. Failed checkout leaves the cart intact.

## Consequences

- Members on different devices see the same saved cart without browser storage.
- Organization members can see each other’s in-progress article and brief content. Explicit UI disclosure is required.
- A conflicting edit is rejected and must be reviewed from the current shared cart; silent last-write-wins is not allowed.
- Successful order checkout removes only cart rows submitted in that order. The organization cart remains available after sign-out.
- The schema migration must be applied before enabling the application code. Database backups and retention controls apply to cart drafts.

## Revisit trigger

Revisit if customer privacy expectations, organization roles, draft retention requirements, cart size, or concurrent editing patterns change materially.
