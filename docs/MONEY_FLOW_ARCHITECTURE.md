# Money Flow Architecture

**Status:** Approved v1 financial control contract; real-money activation remains gated
**Scope:** USD organization-wallet funding, wallet-funded multi-listing checkout, item refunds, disputes, reconciliation, and manual supplier-cost records
**Out of scope:** Supplier payout execution, supplier wallets, customer cash-out, and general ledger

## 1. Financial ownership and currency

Stripe moves external money and supplies evidence about its transaction. GPHKM's immutable ledger owns the customer wallet liability, order debits, wallet refunds, and financial history. A provider balance, browser redirect, success screen, operator note, or caller-supplied ID is never proof for an internal ledger mutation.

V1 uses USD for organizations, wallet funding, orders, and refunds. Stripe charges in USD. Foreign card issuers may convert the charge and apply their own fees. GPHKM absorbs Stripe processing fees and credits the same USD amount as the settled top-up. Record provider gross and provider fees separately for reconciliation.

Amounts use integer minor units or exact decimals, never binary floating point. No multi-currency wallet or local-currency presentment in v1.

## 2. Authoritative financial records

- **Wallet account:** one organization and USD; available balance is a projection of ledger entries and holds.
- **Wallet ledger entry:** append-only funding credit, purchase debit, item refund credit, reversal, or approved adjustment with unique reference, amount, currency, organization, actor/source, and related aggregate.
- **Payment attempt:** immutable funding intent, provider, amount, currency, idempotency fingerprint, state, and external identities.
- **Provider event inbox:** durable verified/rejected event record unique by provider and event identity, with normalized facts and restricted evidence.
- **Access grant:** one organization grant linked to one qualifying settled wallet credit, with start, end/unrestricted state, status, and policy snapshot.
- **Order and items:** parent checkout with per-item purchased terms, wallet allocation, status, and cost snapshots.
- **Dispute and audit records:** provider dispute evidence, holds, resolution, manual supplier-paid evidence, actor, time, and reason.

Never edit or delete posted ledger entries. Corrections are compensating entries linked to the original and approved reason. Reconcile the balance projection to ledger-derived funds and holds.

## 3. Wallet top-up

Only Stripe is enabled for v1. The custom checkout requests a USD amount and creates an immutable payment attempt. Validate configured amount and risk limits server-side. Do not infer payment success from the browser return route.

A verified provider event must match environment, merchant account, attempt, organization, amount, currency, and terminal settlement state. Verify the signature against the exact request bytes. Persist and deduplicate the provider event. In one transaction, record the event result, mark the payment attempt settled, post one wallet credit, append audit evidence, create any qualifying access grant, and record notification intent.

Use idempotency scoped to organization, actor, operation, and normalized request. Provider event ID, provider payment identity, and internal ledger reference are distinct unique identities. Exact replay returns the canonical prior result. Conflicting amount, organization, or event identity fails closed and is alerted. Ambiguous provider timeouts remain pending until reconciled; never create a second charge under a new idempotency identity.

The customer is charged and credited the same USD amount. GPHKM absorbs processing fees and reconciles them separately. No direct provider capture for an order and no split wallet/provider tender in v1.

## 4. Marketplace access grants

One settled top-up whose wallet credit is at least $50 USD qualifies. A pending, failed, promotional, manual, or redirect-only credit does not qualify. The initial access term is six calendar months, starting at settlement; a qualifying top-up during the 15-day trial starts its term immediately. Calculate calendar terms in UTC and clamp month-end dates to the last valid day (for example, six months from August 31 ends on the last day of February).

Each qualifying wallet credit can create only one grant. The grant enables catalog browsing and hidden URLs for its recorded interval. Spending wallet funds does not shorten the grant. Each qualifying top-up creates its own linked grant under the policy active at settlement. With finite grants, the new interval starts at the later of the latest recorded finite expiry or settlement. If the policy is unrestricted, that grant has no expiry. If an unrestricted grant is already active, a later top-up creates a separate grant starting at settlement under the current policy; it does not alter the unrestricted grant or any other interval. Grants keep their recorded intervals if another grant is revoked; access can have a gap until a later recorded interval begins. Do not shift other grants to close gaps.

A pending dispute suspends only its linked grant. A verified loss, refund, or reversal revokes only the linked grant. A dispute win restores the same grant and original expiry; time continues to run while suspended. Global minimum and duration policy is audited, versioned, and applies to future grants only.

## 5. Order checkout and wallet debit

The customer may select up to 25 distinct listings, one placement per listing. At confirmation, revalidate organization membership, catalog entitlement, listing status/revision, terms, price, and available balance. Snapshot placement price and optional GPHKM Writing fee as separate components. For an eligible writing listing, snapshot the Admin-configured two-stage writing fee allocation shown to the customer: first complete draft delivered, then final draft delivered after the included revision. If the customer approves the first draft without requesting a revision, that approval completes both stages. A delivered stage's amount is earned; only the amount allocated to an undelivered stage may be refunded under the disclosed policy.

In one database transaction, create the parent order, all order items and initial item events, immutable purchased listing/content/fulfillment snapshots, one aggregate wallet debit, audit event, and notification intent. The transaction commits all items and debit or none. The retail price snapshot is fixed for the order item; later supplier source-cost or listing-price changes never reprice it. Idempotent replay returns the same order; a reused key with changed intent is rejected.

The wallet balance cannot become negative through ordinary order spending. Use database constraints/locking appropriate to the selected database access layer. Do not rely on a client-calculated total.

## 6. Cancellations, item refunds, and writing

Before the applicable cutoff, a customer may request cancellation of an individual item. The assigned Admin reviews the request and may approve cancellation under the published item and writing-stage policy; the system computes the exact wallet credit. For supplier email, the cutoff is provider acceptance or a staff-recorded manual send; export/preparation alone is not handoff. For platform/internal fulfillment without supplier email, the cutoff is when assigned staff records fulfillment work as started. After the cutoff, customer cancellation and refunds are not allowed by default. Admin staff may investigate a documented Support case and attempt supplier withdrawal where possible. Only Finance or Super Admin may approve an item-specific post-cutoff wallet refund after reviewing the case and evidence; approval is not guaranteed. Legal or processor-required exceptions may require a different remedy. Never issue an external payment refund through this exception path unless that approved exception requires it.

A supplier rejection, nonresponse, or inability to fulfill after handoff is also reviewed by Admin staff through the Support case and does not trigger an automatic refund. Staff may offer an equivalent only with customer approval. If no acceptable equivalent can meet the purchased customer-facing terms, Admin staff handling the Support case may refer an item-specific wallet refund for Finance or Super Admin approval. Other order items continue. Keep the retail price snapshot fixed; source-cost variance affects actual margin, not the customer charge. For an internally fulfilled item, assigned staff records work start; a later cancellation request follows the same post-cutoff Support exception path.

An order-item refund is a new wallet credit linked to the original item debit and approved reason. Total refunds cannot exceed the item's captured retail amount. A canceled item does not refund unrelated items. A wallet refund is not an external Stripe refund.

After valid publication completion, later disappearance alone creates no replacement or refund entitlement, even if caused by a search/platform update. Record the known cause without rewriting original verification evidence. A never-delivered or incorrectly verified placement follows the pre-completion failure policy. Legal or processor-required exceptions remain available.

Writing is a separately priced add-on. The customer receives a draft and one included revision for approval before supplier handoff. Extra revisions require a quote and approval. If writing work has started, completed work is not refunded; only undelivered work may be refunded under the disclosed itemized policy.

## 7. Supplier costs and manual paid status

Keep source cost separate from customer wallet accounting. Snapshot a confirmed direct supplier or writing cost to the order item when it is confirmed. Unknown costs remain explicitly unknown; gross-profit reporting is provisional until known. A later correction is a reasoned, audited adjustment, never an overwrite. A source-cost change on an existing order changes its actual margin record, not the locked customer retail price. Reprice the listing only for future orders to preserve the intended margin.

Gross profit is retail revenue after refunds minus confirmed direct source and writing costs. Provider processing fees are shown separately. Optional direct costs may be recorded for platform-owned fulfillment and writing. Do not count unknown as zero.

Finance or Super Admin may record manual supplier paid/unpaid status. The actor must provide amount, date, evidence/reference, and reason/evidence before changing status. Record who and when in audit. This is a record of an external manual action; GPHKM does not execute payouts.

## 8. Disputes and chargebacks

Create one dispute case linked to the exact funding attempt, wallet credit, and provider dispute identity. Record amount, currency, deadlines, evidence, and state. Hold remaining available funds where possible; suspend the linked access grant and restrict new spending as needed. Do not silently edit the ledger or create an unbounded negative balance.

On a verified win, release the hold and restore the linked grant with its original expiry. On a verified loss, post an authorized compensating ledger entry for the recoverable amount, record uncovered exposure separately, and revoke only the linked grant. Keep other valid grants unchanged. Reconcile provider dispute events and account restrictions idempotently.

## 9. Reconciliation, audit, and launch gates

Reconcile provider attempts/events/fees against wallet credits, ledger totals against balance projections, orders/items against debits/refunds, disputes/holds against provider results, and manual supplier cost/payment records against evidence. A mismatch creates an owned finding; reconciliation never silently edits financial data.

Before real-money production, require:

- U.S. state/entity, Stripe account and merchant configuration.
- Qualified legal/finance approval of wallet, refund, privacy, terms, non-expiring balance, no-cash-out, and legal/processor exception policies.
- Verified webhook signatures, exact matching, idempotency, timeout recovery, sandbox certification, and reconciliation.
- Approved top-up/order risk limits and operational refund/dispute procedures.
- Restricted database roles, RLS, immutable ledger constraints, audit, backups, restore rehearsal, and incident runbooks.

A general ledger is not included unless Finance requires it. Maintain a wallet/order subledger and provider/cost reconciliation exports.
