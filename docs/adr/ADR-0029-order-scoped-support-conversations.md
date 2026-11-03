# ADR-0029: Order-scoped active Support conversations and standalone cases

- **Status:** Accepted
- **Date:** 2026-11-03
- **Decision owners:** Product / Engineering / Security

## Context

An order may contain several independently assigned items. Customers need one coherent conversation for an order, while staff authority to inspect or change item fulfillment must remain scoped to each item. General questions also need a Support path when there is no relevant order. Resolved or closed conversations must remain durable records rather than being reopened for later, unrelated issues.

## Options considered

1. Keep one Support case per order item. This preserves a direct item link but fragments customer communication and duplicates order-wide context.
2. Use one active Support conversation per order and separate unlinked cases for general Support. This consolidates communication while retaining item-level outcomes and authority.
3. Use one organization-wide Support case. This would merge unrelated orders and make visibility and case closure harder to reason about.

## Decision

Use one active customer-facing Support conversation per order. A new customer message about that order joins its active conversation. General Support cases remain unlinked to orders. A supplier-failure outcome for an order item is attached to the order's active conversation, creating one if none is active.

This supersedes the earlier item-linked case-scope assumption in [ADR-0008](ADR-0008-item-cancellation-and-refunds.md). ADR-0008's item-level cancellation/refund rules remain in force.

The case may contain outcomes for several items, but the item remains the unit of fulfillment authority: offers, route changes, cancellation/refunds, and access to item content require the relevant item's assignment. An Admin may view an order-level conversation when assigned to at least one item in that order. Standalone cases are visible to Admins under authorized Support access. Super Admin access is audited. Customer Owner and Member case visibility remains governed by the customer-role matrix.

A case cannot be resolved or closed while any supplier-failure item outcome attached to it remains unresolved. Each failed item must have a current accepted equivalent route or be canceled/refunded. Resolved and closed cases are terminal and do not accept new customer replies. Once an order conversation is terminal, a later issue about the order opens a new case and starts a new conversation.

## Consequences

- The active case is an order-level communication aggregate; item outcomes remain independently actionable and auditable.
- An item's intake reference may be retained for context, but it does not limit the case to that item.
- Customer messages join the active order conversation, including messages started from an item's page.
- Standalone Support remains available without order context and does not acquire order or item authority.
- Staff case visibility does not grant authority to inspect or modify every item in the order. Content reads and item actions continue to require the corresponding item assignment.
- Case closure must account for every supplier-failure outcome attached to the conversation. After terminal closure, later issues create a fresh case rather than rewriting the historical conversation.

## Revisit trigger

Revisit if measured Support volume or a legal/audit requirement demonstrates that unrelated issue threads within one order must have independent active lifecycles, while preserving the same item-level authorization boundaries.
