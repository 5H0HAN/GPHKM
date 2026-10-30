# Domain Model and Data Boundaries

**Status:** Approved conceptual model; final table names follow the Slice 0 database decision.

## 1. Core relationships

- A verified User creates an initial Organization as Owner and may hold active Memberships in multiple Organizations. Invites are email-bound, accepted by the same verified address, expire after seven days, and default to Member; the last Owner must transfer ownership before leaving/removal.
- An Organization owns one USD Wallet, marketplace access Grants, Orders, and membership history.
- A Wallet has immutable Ledger Entries. A Payment Attempt may produce one settled Credit and, when qualifying, one linked access Grant.
- A Listing has immutable revisions and an internal commercial source. A Supplier may be linked to supplier-sourced listings; a fulfillment contact is a separate relation.
- An Import Batch contains staged rows and review/apply decisions.
- An Order contains one or more Order Items. Each item snapshots a listing revision, customer requirements, retail amount, fulfillment assignment, and publication terms.
- An Order Item has explicit fulfillment events and allowed transitions, a separate customer-safe status projection, content change requests/versions and consent, publication evidence/correction history, direct cost records/adjustments, separate placement/writing price components, and item-level refund references.
- A Writing Fee Stage records the listing's disclosed amount and whether the first draft or final draft after the included revision was delivered. Approval of the first draft without a requested revision completes both stages. Only undelivered stage amounts are refundable under the item policy.
- A Support Case belongs to an organization and links to an order/item where applicable. It records requester, assigned Admin, reason, customer-visible messages, private staff notes, evidence references, status history, and any Finance/Super Admin refund decision.
- An Order Item Assignment determines which Admin may access its article, supplier packet, and manual handoff evidence. Assignment changes are audited.
- A Staff Membership grants Admin, Finance, or Super Admin permissions.
- Supplier Handoff Packet groups eligible items for one supplier within one order; immutable versions snapshot the recipient, exact content, consent references, and included items.
- Handoff Attempt records automatic provider or manual-send attempt, event/message references, status, and evidence without overwriting prior attempts.
- Audit Events record sensitive commands, packet/export/send events, manual supplier payment status, and money/access changes. Audit records are append-only; corrections are linked follow-up events.

## 2. Aggregate responsibilities

| Aggregate | Responsibility |
|---|---|
| Organization | Customer tenant, member roles, shared wallet, access grants, and orders |
| Wallet and ledger | USD customer liability, exact credits/debits/refunds, immutable financial references |
| Payment attempt | Stripe funding intent, provider identifiers, amount/currency, settlement evidence |
| Access grant | One qualifying wallet credit, recorded interval/status, and access-policy version |
| Supplier | Private contact, inventory provenance, and fulfillment relationship; no supplier login |
| Import batch | Source, checksum/reference, mapping, staged values, validation, review, and apply history |
| Listing and revision | Customer-safe retail offer plus protected source/fulfillment data; revision locks purchased terms |
| Order | One multi-item checkout and total wallet debit |
| Order item | One placement with independent status, article/brief, cost, fulfillment, publication evidence, and refund |
| Support case | Organization and optional order/item link, customer-safe messages, private staff notes, status history, evidence references, and refund decision |
| Writing fee stages | Per-listing disclosed allocation for first draft and final draft after the included revision |
| Order-item assignment | Current Admin authority to access one item's order content and handoff evidence |
| Supplier handoff packet | One order and supplier grouping, with immutable version, recipient/content snapshot, consent reference, and item list |
| Handoff attempt | One provider send or manual handoff record, with outcome/evidence references; retries are separate attempts |
| Audit event | Actor, action, target, time, reason, result, and safe correlation metadata |

## 3. Ownership and access map

| Data family | Owner/scope | Customer access | Staff access |
|---|---|---|---|
| User/session | User | Self | Restricted identity/security operations |
| Membership | Organization | Own active organization membership | Admin/Super Admin as assigned |
| Wallet/ledger/top-up | Organization | Owner sees history; Members see balance/sufficiency | Finance/Super Admin |
| Access grant | Organization | Effective access state only | Super Admin policy access; scoped Finance support |
| Listing customer fields | Platform catalog | Live projection when signed in and entitled | Admin and Super Admin |
| Source mode/supplier/contact/cost | Platform/supplier internal | None | Admin for catalog/assigned fulfillment; Finance for costs; Super Admin |
| Import files/rows | Staff workflow | None | Admin and Super Admin |
| Order content and evidence | Organization/order item | Authorized organization users | Admin only for assigned fulfillment; Finance payment/reconciliation metadata only, no article or packet content |
| Provider raw payload | Payment operation | None | Restricted Finance/security access |
| Supplier packet and attempts | Order item / supplier record | Customer-safe milestones only | Assigned Admin and Super Admin |
| Handoff packet content and recipient | Order item / supplier record | No | Assigned Admin; Super Admin |
| Handoff transport/reconciliation metadata | Platform security boundary | No | Assigned Admin; Finance reconciliation metadata only, never content; Super Admin |
| Support case | Organization/order item | Owner: all org cases; Member: cases opened by them or tied to their orders | Assigned Admin investigates; Finance/Super Admin access decision fields as needed |
| Internal reports/export | Platform | None | Internal JSON export is Super Admin-only |

PostgreSQL with focused RLS is required for organization-owned records. Set tenant context in trusted server transactions and use restricted runtime identities. RLS is row-level; server authorization and field-level projections remain necessary.

## 4. Immutable purchase and cost snapshots

At checkout, snapshot organization, actor, listing revision, placement amount/currency, separate writing add-on amount and disclosed stage allocation when selected, customer-visible placement terms, content requirements and customer answers, and internal fulfillment assignment. Later catalog or supplier changes do not rewrite an order item.

Customer content change requests before handoff are reviewed by the assigned Admin. Approved changes create a new content/packet version and require renewed consent to share content with the publication-site/fulfillment partner. Internally bind consent to the exact content, supplier, and recipient. After handoff, corrections are separate supplier messages and do not rewrite the original packet.

Record confirmed direct supplier/writing cost when known. Unknown remains explicit and makes gross profit provisional. Later changes are audited adjustments with reason and actor; do not overwrite the historical value. Provider fees are stored separately from direct fulfillment cost.

## 5. Data lifecycle and publication

Raw staff import files and staff-only handoff evidence are private objects with access metadata in PostgreSQL and are retained only for the approved operational/audit period. Staged rows preserve source values and reviewed changes; staff may apply selected valid rows while invalid/duplicate-flagged rows stay staged. Customer order details, articles, briefs, supplements, and Support requests are text fields; customer-uploaded attachments are not supported in v1. Final article and order/publication records are retained as needed for fulfillment, order history, and disputes. Minimize/delete private briefs and drafts after their need ends. GPHKM-generated packet PDFs are derived from immutable packet snapshots. Financial and audit evidence follows legal/accounting retention requirements.

Publication completion stores live URL, verification time, verifier, method, and evidence reference. Later availability observations are separate, append-only facts; they do not rewrite completion evidence. A later link disappearance creates no replacement/refund entitlement after valid completion.
