# GPHKM Marketplace and Finance

This glossary defines the customer-placement and internal supplier-finance terms used across GPHKM.

## Customer content

**Acceptable-content policy**:
The platform-wide rules customers accept for submitted articles, destination links, rights, listing requirements, and sensitive-topic review. Each order records the policy version and acceptance time.
_Avoid_: Supplier content policy

## Supplier finance

**Supplier transfer event**:
An immutable record of an actual manual transfer to one supplier, with one or more order-item allocations.
_Avoid_: Unpaid record, payout request

One transfer may be allocated across multiple order items for its supplier. The allocations must sum to the transfer amount.

**Confirmed actual supplier cost**:
The direct cost GPHKM confirms it owes a supplier for an order item. If it is not known, the payable amount is unknown rather than zero.
_Avoid_: Estimated cost, retail price

**Supplier payable status**:
The current comparison of confirmed actual supplier cost with recorded transfer events: unpaid, partially paid, paid, or overpaid.
_Avoid_: Payment status event

## Support

**Order-level Support conversation**:
The one active customer-facing Support case for an order. It can contain messages and supplier-failure outcomes for several items, while item decisions and fulfillment authority remain specific to each item.
_Avoid_: Item-level ticket

**Standalone Support case**:
A general Support case that is not linked to an order.
_Avoid_: Unassigned order case

**Terminal Support case**:
A resolved or closed case that no longer accepts customer replies. A later issue starts a new case; for an order, that is a new conversation.
_Avoid_: Reopened conversation
