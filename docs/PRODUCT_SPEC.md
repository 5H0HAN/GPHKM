# Product Specification

**Status:** Approved v1 product baseline
**Implementation status:** Slice 0 foundation underway
**Canonical references:** [Money flow](MONEY_FLOW_ARCHITECTURE.md), [Supplier handoff](SUPPLIER_HANDOFF.md), [RBAC](RBAC_MATRIX.md), [Domain model](DOMAIN_MODEL.md), [Security baseline](SECURITY_BASELINE.md)

## 1. Product surfaces

GPHKM is one web application with two protected areas:

- **Customer area:** organization profile, catalog, wallet, custom top-up checkout, bulk cart, order status, and account settings.
- **Admin area:** supplier directory, inventory imports, listing review/pricing/publication, order fulfillment, finance actions, reporting, and audit.

Business rules and authorization run on the server. The browser is not trusted to enforce roles, organization scope, wallet balance, listing access, or order state.

## 2. Customer identity and organization

Customers use verified sign-in through Better Auth with Google sign-in. A verified user creates an organization at first signup and becomes its Owner. Users may belong to multiple organizations and switch active organizations; joining another organization requires an invitation. An Owner invites by email; the invitee must accept while signed in with that verified email. Invitations expire after seven days, default to Member, and may be revoked. Owners may promote an active Member to co-Owner. An organization must always have an Owner; the last Owner must transfer ownership before leaving or being removed. Membership changes do not restart an organization's 15-day trial.

The account area includes:

- Personal profile, sign-in/security controls, session review and revocation, and recovery.
- Organization settings, membership, and billing profile, managed by the Owner.
- Itemized order history and customer-safe status history.
- Organization wallet balance and recharge history for the Owner; members see balance/sufficiency but not recharge history.
- Transactional notification preferences and an optional, separate, revocable newsletter choice.
- Text-only Support requests opened from an order or item, with customer-visible status and replies.

Record the accepted Terms and Privacy versions, actor, and timestamp. Require acceptance during onboarding and require acceptance of a materially changed version before the next protected action. Google OAuth consent is not acceptance of GPHKM terms.

There is no public staff signup. Bootstrap the first Super Admin through a one-time controlled setup procedure. Super Admin invites staff as either Admin or Finance; ordinary staff accounts hold one role bundle, and Super Admin is the only all-access role. Require staff MFA and revoke sessions when an account is deactivated. Organization closure requests are managed through Support in v1. Do not complete closure until active orders/disputes are resolved and the wallet balance is zero, except for a legally required exception. No voluntary wallet cash-out is provided. An approved closure revokes customer access while retaining required financial, order, and audit records and minimizing personal data as law permits.

### Marketplace access

The organization can browse from its creation time through the 15-day trial. Show a top banner with a days/hours/minutes countdown derived from server timestamps. Remove the trial banner once a qualifying paid grant activates. When the trial and grants are inactive, block catalog browsing server-side and show a recharge prompt; account, wallet, existing orders, settings, and support remain available.

A settled wallet credit of at least $50 starts access immediately, including during the trial. The initial global policy grants six calendar months; policy options are six months, one year, or unrestricted. Policy changes are audited and apply to future grants only. A grant is linked to its qualifying credit, and access does not end when the wallet is spent down.

Each qualifying top-up creates its own linked grant under the policy active at settlement. With finite grants, the new interval starts at the later of the latest recorded finite expiry or settlement. If an unrestricted grant is already active, the new grant starts at settlement under the current policy and does not alter the unrestricted grant or any other interval. If a grant is suspended or revoked, preserve every other grant's dates; access may resume at the next grant's recorded start. A pending dispute suspends only its linked grant. A verified loss/reversal/refund revokes only that grant; a dispute win restores the same grant with its original expiry.

The listing-level public URL setting bypasses URL concealment only; it never bypasses verified sign-in or the browsing requirement. Do not return unauthorized listing data or URLs to the browser.

## 3. Catalog, supplier inventory, and listing rules

Each listing has one orderable offer and one placement per checkout selection. A customer checkout can include at most 25 distinct listings.

Customer-facing listing fields include niche/category, language/region, retail price, service/content/link requirements, turnaround estimate, placement term, and approved source-attributed metrics. Required fields must be complete and staff-reviewed before publishing.

Commercial source is either platform or supplier. Fulfillment contact is a separate relation. Source classifications, supplier identity, supplier contacts, source cost, staff notes, import data, and supplier performance are internal and never shown to customers.

### Supplier inventory imports

Support CSV/XLSX uploads and direct refresh of public/readable Google Sheets. Every refresh enters staging with source, actor, time, mapping, validations, duplicates, and before/after changes. Staff review and explicitly apply accepted rows.

Imports must not publish a listing or change retail price, approved requirements, or live status automatically. Stale or conflicting supplier data is flagged for staff review; staff decides whether to pause an offer. Never fetch arbitrary URLs supplied inside imported rows. Likely duplicate domains are flagged; keep separate offers if source, price, or terms differ.

### Listing lifecycle

Listings move through draft, review, live, paused, and archived states. Publishing, pausing, and material changes are permission-checked and audited. Price, service terms, content/link requirements, fulfillment assignment, and placement term changes create a revision. Existing orders retain the purchased snapshot.

### Metrics

Store Ahrefs Domain Rating, Moz Domain Authority, and Open PageRank as separate provider observations with normalized target, source, observation date, refresh time, and status. Missing or stale data is not zero. Refresh is staff-triggered and batched in v1. Provider keys stay server-side. Customer display requires current provider license, attribution, redistribution permission, and cost review. Metrics are not guarantees of search ranking or site quality.

## 4. Wallet and custom checkout

The custom checkout page starts a wallet top-up through Stripe in v1. Stripe charges in USD. Foreign card issuers handle any cardholder currency conversion and issuer fees. GPHKM absorbs Stripe processing fees; the customer receives the same USD wallet credit as the settled charge amount.

A settled top-up credit of at least $50 USD qualifies for marketplace access. Pending, failed, promotional, manually adjusted, or redirected-but-unverified funding does not qualify. PayPal and additional payment methods are later additions; v1 order checkout is wallet-funded only.

Wallet funds do not expire. Customers have no voluntary cash-out. Canceled order items are credited back to the organization wallet. Finance handles legal or processor-required exceptions. Payment disputes can hold remaining wallet funds and restrict new spending while investigated. See the [Money Flow Architecture](MONEY_FLOW_ARCHITECTURE.md) for ledger and provider invariants.

## 5. Multi-listing orders

- Customer selects one placement per listing, up to 25 distinct listings.
- The server rechecks membership, marketplace access, listing revision/live state, item requirements, current price, and wallet sufficiency at confirmation.
- If a listing is unavailable or its terms changed, stop checkout and ask the customer to review the cart. Never silently reprice or remove an item.
- Create the parent order, item snapshots, initial item events, and one total wallet debit in a single transaction. The full checkout commits or none of it does.
- Each item has an independent fulfillment state, customer status projection, cancellation/refund outcome, and cost record. Parent status summarizes items without hiding any delayed or blocked item.
- The retail price accepted at checkout is fixed for that order item. If supplier source cost changes, do not reprice the existing order; record confirmed actual cost and resulting margin. Update listing retail price only for future orders to preserve the intended margin.
- Before the handoff/work-start cutoff, a customer may request cancellation of an individual item. The assigned Admin reviews it and may approve a policy-based cancellation; the exact eligible amount is credited to the organization wallet. For supplier email, handoff occurs when the provider accepts the send or staff records an actual manual send; export/preparation alone is not handoff. For platform/internal fulfillment without supplier email, the cutoff is when assigned staff records that fulfillment work started. After the applicable cutoff, ordinary cancellation and refund are not allowed by default. Admin may investigate a documented Support case and attempt supplier withdrawal where possible; only Finance or Super Admin may approve a post-cutoff wallet refund after evidence review. Approval is not guaranteed. No external payment refund is implied, except where legally or processor-required.
- Supplier rejection, nonresponse, or inability to fulfill after handoff also requires Admin staff review through the Support case; it does not trigger an automatic refund. Offer an equivalent only with customer approval. If no acceptable equivalent can meet the purchased customer-facing terms, Admin staff handling the Support case may refer an item-specific wallet refund for Finance or Super Admin approval. No silent substitution.
- The retail price accepted at checkout stays fixed. Supplier source-cost changes alone do not change the customer's price; record actual cost and margin, and update the listing price only for future orders. See [Supplier Email Handoff](SUPPLIER_HANDOFF.md) for cancellation notices and evidence.

## 6. Content and optional GPHKM Writing

Customer-provided article content is the default. The customer supplies the article and listing-specific publication/link instructions. All customer order details and order-related supplements are text-only fields in v1, including article text, writing briefs, target URLs, anchor text, and publication instructions. Do not provide customer file uploads or attachments in the order flow. Accept plain text with ordinary line breaks; enforce field-specific length limits, validate structured values such as URLs, and treat every value as untrusted text when displayed, exported, or sent.

Eligible listings may offer a paid GPHKM Writing add-on with an admin-set price and turnaround. Checkout snapshots the placement price and writing fee separately. Each writing listing discloses two fee stages set by Admin: delivery of a complete first draft and delivery of the final draft after the included revision. If the customer approves the first draft without requesting a revision, that approval completes both stages. Only the amount allocated to an undelivered stage may be credited on cancellation; a delivered stage's amount is earned. The customer supplies a text brief; GPHKM drafts the article; the customer reviews and approves it before handoff. One included revision is available. Additional revisions require a separate quote and customer approval.

If the customer declines further revisions, stop the writing add-on and apply the disclosed stage allocation. Do not send customer names, account details, or billing information to a publication site/partner. At checkout, explain that the approved article and necessary link instructions will be shared with the publication site/partner fulfilling the placement; record item-level consent. Do not expose supplier identity, sourcing classification, source costs, or reseller mechanics. Keep customer-facing language GPHKM-branded. Staff inventory imports and staff-only handoff evidence are separate admin workflows; GPHKM-generated supplier PDFs are rendered from the reviewed text packet and are not customer-uploaded files.

Apply a short platform-wide acceptable-content policy as well as each listing's specific requirements. Customers confirm they have rights to submitted content and destination links. Admin may hold or reject illegal/abusive material, phishing/malware, content without usage rights, or material that violates a listing's rules. Sensitive but potentially legal topics (including gambling, adult, health, finance, or political content) require Admin review against the listing rules rather than automatic blanket rejection. Give the customer an opportunity to correct held content or resolve the item under the cancellation policy. Do not guarantee ranking or SEO outcomes.

## 7. Order and publication states

Wallet debit and order creation are one atomic event. There is no unpaid order state after a successful checkout.

A typical internal item flow is:

Confirmed → Content Preparation / Awaiting Customer Approval → Ready for Handoff → Handoff Pending → In Fulfillment → Publication Pending → Evidence Review → Completed

Use only these transitions: Confirmed → Content Preparation; Content Preparation → Awaiting Customer Approval or Ready for Handoff; Awaiting Customer Approval → Content Preparation (customer requests the included revision) or Ready for Handoff (customer approves); Ready for Handoff → Handoff Pending (supplier email) or In Fulfillment (internal work begins); Handoff Pending → In Fulfillment when provider acceptance/manual send is recorded; In Fulfillment → Publication Pending → Evidence Review → Completed. Failed evidence returns to Publication Pending. An audited Correction Review may move an incorrectly completed item back to Publication Pending, preserving the original completion evidence. On Hold stores the previous active state and resumes only to that state through an audited action. Cancellation Requested returns to the prior state if denied/withdrawn or moves to Canceled/Refunded when an eligible wallet credit is posted. Completed and Canceled/Refunded are terminal except for the specific correction-review path. Use explicit audited commands; no generic status override. Keep packet transport state separate from item fulfillment state and customer-visible status. Unknown email outcomes enter reconciliation immediately and block resend. Provider acceptance without delivery confirmation after 72 hours enters delivery follow-up. The supplier-acknowledgement timer starts 72 hours after provider-confirmed delivery or staff-recorded manual send. These are internal follow-up targets, not supplier SLAs.

Customers see only GPHKM-branded milestones: Order Received, Content Review (when needed), Preparing Your Placement, Publication in Progress, Link Verification, and Complete/Resolved. Show the last-updated time and next-update date. For supplier email, Publication in Progress begins after provider-confirmed delivery or a staff-recorded manual send; for internal fulfillment without supplier email, it begins when assigned staff records work as started. Provider acceptance without delivery confirmation remains Preparing Your Placement while staff follows up. Notify the Member who placed the order in-app and by transactional email about customer-visible order milestones and actions needed. The Owner can view all organization orders in-app but is not automatically emailed about each Member's order. Do not expose supplier, source, or packet states. Alert staff when a customer next-update date is overdue; do not promise a universal turnaround.

Customers may open a text-only Support request from an order or item page. Each case links to the relevant organization and order/item. Internal case states are Open, Investigating, Waiting on Customer/Supplier, Finance Review, and Resolved/Closed. Customer-visible case labels are Received, In Review, Waiting on You, and Resolved. Admin investigates; Finance or Super Admin decides post-handoff refund exceptions. Owners see all organization cases; Members see cases they opened or tied to their own orders. Notify the case opener in-app and by transactional email for customer-visible replies/status changes. Never expose internal notes, supplier details, or Finance deliberations. Support case text does not accept file attachments.

### Completion and later disappearance

A staff member records the live URL, observed time, verifier, and evidence to complete an item. Google indexing is tracked separately and remains unknown unless authorized Search Console data is available.

If staff later discovers that a completion was incorrectly verified (for example, the wrong URL), an assigned Admin or Super Admin may open an audited correction case and resume the pre-completion failure workflow. Preserve the original completion evidence and append the correction and new verification; do not overwrite history. A correctly verified link that later disappears remains subject to the no-replacement/no-refund policy below.

A listing may be sold with a lifetime placement term. This means the publisher intends to keep the placement live indefinitely; it is not a GPHKM guarantee. The listing and checkout snapshot must disclose that continued availability is not guaranteed. After valid completion, a later disappearance does not create a replacement or refund entitlement, including when attributed to a search/platform update. Record and explain a known cause without inventing one or rewriting the original completion evidence.

A placement that was never delivered or was incorrectly verified follows the pre-completion failure policy. Required legal or processor exceptions also remain available.

## 8. Supplier operations and reporting

Supplier profiles are private and include contacts, inventory, source history, listing links, and fulfillment history. A platform-sourced listing may still have an external fulfillment contact. Admin or Super Admin assigns/reassigns each order item to an Admin; only the assigned Admin may access that item's article, supplier packet, and handoff evidence. Assignment changes are audited. Super Admin access is audited.

Supplier email packets, provider sends, manual exports, item-level handoff state, audit evidence, and reconciliation follow the [Supplier Email Handoff](SUPPLIER_HANDOFF.md) specification. Staff handoff contains only the article/brief, approved link instructions, and publication requirements needed for the assigned item. It excludes customer identity, account, and billing data.

Supplier performance reporting uses a trailing 90-day window and displays sample size. Measures include paid placements, completed, rejected, canceled and refunded counts, net sales, median publication time, and on-time rate where a due date exists. Use sortable measures; do not combine them into a weighted score.

The internal JSON report export is Super Admin-only. It may contain supplier contacts, inventory, metric history, and order-item performance. Exclude customer names, briefs/content, credentials, and payment payloads. Source costs and gross-profit views require cost permission. Admins may generate only the minimum-data supplier handoff for assigned work; this is not an internal report export.

## 9. Costs and margin

Keep listing source cost internal. Snapshot confirmed direct supplier and writing costs to the order item when confirmed. If a cost is unknown, mark it unknown and show gross profit as provisional; never treat unknown as zero. Corrections are reasoned, audited adjustments and do not overwrite the original record.

Gross profit is retail revenue after refunds minus confirmed direct source and writing costs. Show payment-provider fees separately. Platform-owned fulfillment and writing may have optional direct costs. No general ledger or supplier payout execution is included.

When Finance or Super Admin records that a supplier was paid manually, require amount, date, evidence/reference, actor, and audit event. This records an operational fact only; GPHKM does not initiate a supplier payment.

## 10. Authorization and customer-data boundary

Customer requests require an active session and organization membership. Staff requests require an active staff identity and the exact permission. Recheck authority for each sensitive command and protected read. PostgreSQL RLS is defense in depth.

Use explicit allowlisted customer projections. Never serialize internal listing, supplier, cost, import, audit, or provider records into customer responses. Hidden URLs and inaccessible catalog records are omitted server-side, not delivered behind a blur. Customer responses and messages use the GPHKM-branded milestones in Section 7 and the neutral publication-site/partner disclosure; they never expose supplier identities or sourcing classifications.

## 11. Retention

Retain the final article and order/publication record as needed to support fulfillment, customer history, audit, and disputes. Customer order content is text-only; there are no customer-uploaded order attachments in v1. Minimize or delete private briefs and drafts when fulfillment and dispute needs end. Staff-only inventory files and handoff evidence follow separate access and retention rules. Retain financial and audit evidence according to applicable legal and accounting requirements. Define exact retention periods with legal/finance before production.
