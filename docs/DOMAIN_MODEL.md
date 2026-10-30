# Domain Model and Data Boundaries

**Status:** Approved conceptual model; final table names follow the Slice 0 database decision.

## 1. Core relationships

- A verified User creates an initial Organization as Owner and may hold active Memberships in multiple Organizations. Invites are email-bound, accepted by the same verified address, expire after seven days, and default to Member; the last Owner must transfer ownership before leaving/removal.
- An Organization owns one USD Wallet, marketplace access Grants, Orders, membership history, and an optional Owner-only billing profile. The profile contains legal name, billing email, and billing address; it is not included in supplier handoff or staff projections.
- An Organization Closure Request is opened by an Owner and handled by Admin/Super Admin. Append-only Events record customer-visible updates and internal notes. Finalization requires a zero wallet and no active/unpaid orders or unresolved payment, Stripe, or Support cases; memberships and pending invitations are revoked atomically.
- A Wallet has immutable Ledger Entries. A Payment Attempt may produce one settled Credit and, when qualifying, one linked access Grant.
- A Listing has one orderable placement offer, controlled categories/language/link requirements, immutable revisions, and an internal commercial source. A supplier-sourced listing’s source supplier and fulfillment supplier must be the same supplier. A platform-owned listing may use one external fulfillment supplier. A same-domain website may have separate listings when source, price, or terms differ.
- A Listing Metric Observation records one provider, normalized target/scope, available or missing status, value, provider observation date, refresh time, and source reference. Provider credentials remain outside listing data in server-side environment configuration.
- An Import Batch contains staged rows and review/apply decisions.
- An Order contains one or more Order Items. Each item snapshots a listing revision, customer requirements, retail amount, fulfillment assignment, and publication terms.
- An Order Item has explicit fulfillment events and allowed transitions, an immutable purchased-listing and checkout financial snapshot, and a separate current fulfillment route. Customer-accepted equivalent routes are retained as evidence; they do not rewrite purchase facts. The item also has a separate customer-safe status projection and append-only milestone/next-update history, content change requests/versions and consent, publication evidence/correction history, per-supplier placement cost records plus one internal writing-cost chain, separate placement/writing price components, and item-level refund references.
- A Writing Fee Stage records the listing's disclosed amount and whether the first draft or final draft after the included revision was delivered. Approval of the first draft without a requested revision completes both stages. Only undelivered stage amounts are refundable under the item policy.
- A Support Case belongs to an organization and links to an order/item where applicable. It records requester, assigned Admin, reason, customer-visible messages, private staff notes, evidence references, status history, and any Finance/Super Admin refund decision.
- An Order Item Assignment determines which Admin may access its article, supplier packet, and manual handoff evidence. Assignment changes are audited.
- A Staff Membership grants Admin, Finance, or Super Admin permissions.
- Supplier Handoff Packet groups eligible items for one supplier within one order; immutable versions snapshot the recipient, exact content, consent references, and included items.
- Handoff Attempt records automatic provider or manual-send attempt, event/message references, status, and evidence without overwriting prior attempts.
- Audit Events record sensitive commands, packet/export/send events, actual manual supplier transfer events, and money/access changes. Audit records are append-only; corrections are linked follow-up events.

## 2. Aggregate responsibilities

| Aggregate | Responsibility |
|---|---|
| Organization | Customer tenant, member roles, shared wallet, access grants, orders, and optional Owner-only billing profile |
| Wallet and ledger | USD customer liability, exact credits/debits/refunds, immutable financial references |
| Finance reconciliation | Immutable run snapshots, owned findings, append-only evidence-backed review actions, and allowlisted Stripe charge/refund/dispute/payout gross-fee-net facts |
| Payment attempt | Stripe funding intent, provider identifiers, amount/currency, settlement evidence |
| Access grant | One qualifying wallet credit, recorded interval/status, and access-policy version |
| Supplier | Private contact, inventory provenance, and fulfillment relationship; no supplier login |
| Import batch | Source, checksum/reference, mapping, staged values, validation, review, and apply history |
| Listing and revision | One customer-safe placement offer, category/language/link/content terms, and protected source/fulfillment data; revision locks purchased terms |
| Listing metric observation | Provider-specific registered-domain or host metric with provenance and explicit missing/available status |
| Order | One multi-item checkout and total wallet debit |
| Order item | One placement with independent status, article/brief, cost, fulfillment, publication evidence, and refund |
| Support case | Organization and optional order/item link, customer-safe messages, private staff notes, status history, evidence references, and refund decision |
| Organization closure | Owner-requested Support workflow with append-only customer/internal events and database-guarded finalization |
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
| Wallet/ledger/top-up | Organization | Owner sees history; Members see balance/sufficiency through restricted projections | Finance/Super Admin |
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
| Organization closure request | Organization | Owner submits and reviews; access ends on final closure | Admin/Super Admin; Finance has no closure authority |
| Internal reports/export | Platform | None | Internal JSON export is Super Admin-only |

PostgreSQL with focused RLS is required for organization-owned records. Set tenant context in trusted server transactions and use restricted runtime identities. RLS is row-level; server authorization and field-level projections remain necessary.

## 4. Immutable purchase and cost snapshots

At checkout, snapshot organization, actor, listing revision, placement amount/currency, separate writing add-on amount and disclosed stage allocation when selected, customer-visible placement terms, content requirements and customer answers, and internal fulfillment assignment. Later catalog or supplier changes do not rewrite an order item.

Customer content change requests before handoff are reviewed by the assigned Admin. Approved changes create a new content/packet version and require renewed consent to share content with the publication-site/fulfillment partner. Internally bind consent to the exact content, supplier, and recipient. After handoff, corrections are separate supplier messages and do not rewrite the original packet.

Record confirmed direct supplier/writing cost when known. Unknown remains explicit and makes gross profit provisional. Later changes are audited adjustments with reason and actor; do not overwrite the historical value. Stripe balance-transaction gross, fee, and net facts are captured in Finance refresh snapshots and shown separately from direct fulfillment costs; they never reduce the customer wallet. Payout-to-bank comparison remains a Finance staff attestation, not an independent bank reconciliation or a general ledger.

## 5. Data lifecycle and publication

Raw staff import files and staff-only handoff evidence are private objects with access metadata in PostgreSQL and are retained only for the approved operational/audit period. Staged rows preserve source values and reviewed changes; staff may apply selected valid rows while invalid/duplicate-flagged rows stay staged. Customer order details, articles, briefs, supplements, and Support requests are text fields; customer-uploaded attachments are not supported in v1. Final article and order/publication records are retained as needed for fulfillment, order history, and disputes. Minimize/delete private briefs and drafts after their need ends. GPHKM-generated packet PDFs are derived from immutable packet snapshots. Financial and audit evidence follows legal/accounting retention requirements.

Publication completion stores live URL, verification time, verifier, method, and evidence reference. Later availability observations are separate, append-only facts; they do not rewrite completion evidence. A later link disappearance creates no replacement/refund entitlement after valid completion. The customer projection reports Google indexing as `UNKNOWN` when publication evidence exists; indexing does not gate completion, and v1 has no authorized Search Console data source.
