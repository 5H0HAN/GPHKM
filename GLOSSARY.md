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
