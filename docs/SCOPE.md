# Product Scope

## 1. Initial release boundary

V1 establishes a secure catalog-to-publication loop for customer organizations and staff. Supplier operations stay in the admin area. GPHKM does not provide supplier accounts, publisher self-service, payout execution, or supplier wallets.

## 2. In scope

### Customer experience

- Verified sign-in, profile and security settings, revocable sessions, and account recovery.
- Verified signup creates an organization and first Owner; users may join multiple organizations by verified-email invitation. Owner-managed settings, members, co-Owner transfers, and funding; invitations expire after seven days and default to Member, and the last Owner must transfer ownership before leaving.
- Authenticated catalog with a 15-day organization browsing trial, top-of-page days/hours/minutes countdown, and the approved paid-access rule. The initial access term is six calendar months; the audited global policy can select six months, one year, or unrestricted access.
- Hidden listing URLs by default; public URL flag only bypasses URL concealment while browsing is allowed.
- Multi-listing cart with up to 25 distinct listings and one placement per listing.
- Custom Stripe USD wallet top-up checkout and wallet-funded order checkout.
- Customer-provided article by default; optional paid GPHKM Writing add-on on eligible listings.
- Text-only customer order details and supplements; bounded article/brief/instruction fields with no customer file uploads or order attachments.
- Text-only Support requests linked to orders/items, customer-safe statuses/replies, in-app and email notifications, and Support-managed organization closure.
- Itemized order history, milestones, next-update date, balance, and Owner-visible recharge history.
- Member order placement and own-order view; member sees balance/sufficiency but not recharge history.
- Transactional notices and optional, separate newsletter preference.
- Customer acceptance history for Terms and Privacy, with new material versions accepted before protected actions.

### Admin catalog and supplier operations

- Private supplier directory, contacts, source records, listing connections, and internal performance.
- CSV/XLSX uploads and direct staff-triggered refresh of public/readable Google Sheets into staging.
- Field mapping, validation, duplicate warnings, correction, review, apply, and audit.
- Admin-controlled retail price, listing requirements, live state, publication term, and revisions.
- Separate commercial source (platform or supplier) and fulfillment contact.
- Staff-triggered batched Ahrefs DR, Moz DA, and Open PageRank refresh; customer display only after rights and attribution review.
- Per-item internal order queue and supplier-specific packet handoff, with minimum necessary content, exact recipient preview, provider send, manual EML/PDF export, handoff evidence, milestones, publication evidence, and reconciliation.
- Item-level Admin assignment; minimal Support case workflow; audited item-state transitions, customer content change requests, and correction of incorrect publication verification.
- Platform-wide acceptable-content rules, listing-specific requirements, and neutral disclosure of publication-site/partner sharing without exposing supplier identities or sourcing classifications.
- Manual supplier paid/unpaid record with evidence; no payment execution.
- Trailing-90-day supplier measures with sample size, provisional gross-profit reporting, and Super Admin-only JSON report export.

### Money and security

- Organization-scoped immutable USD wallet ledger and balance projection.
- Stripe funding attempt/webhook verification, idempotency, dispute handling, and reconciliation.
- Atomic multi-item wallet debit and item-level wallet refund credits.
- Better Auth with Google sign-in, server-side authorization, focused PostgreSQL RLS, audit, secure secrets, backups, monitoring, and incident procedures.

## 3. Explicitly out of scope for v1

- Supplier accounts, onboarding, supplier portal, supplier API, or self-service listing changes.
- Automated supplier payout, supplier wallet, payout method, or settlement execution.
- PayPal and additional wallet-funding methods; these may be added after Stripe operations are proven.
- Direct payment-provider order capture, split tender, subscription, or recurring billing.
- Multi-currency wallet, local-currency presentment, or voluntary customer cash-out.
- Automatic listing publication from import, arbitrary URL fetching, or continuous spreadsheet crawling.
- Customer-uploaded article files, images, documents, or other order-related attachments. Staff inventory imports, staff-only handoff evidence, and GPHKM-generated supplier PDFs remain separate admin/system workflows.
- Public staff signup, custom staff-role builder, or combining Admin and Finance role bundles.
- Full support ticketing platform or customer file attachments on order/Support forms.
- Automated publication-link monitoring or a replacement guarantee after valid completion.
- Google indexing guarantee; Search Console checks only where GPHKM has authorized property access.
- Weighted supplier/domain quality score, customer-visible supplier identity/ranking, or general ledger.
- Public catalog access before verified sign-in.
- Separate customer/admin applications, API service, microservices, Redis, or multiple worker lanes.

## 4. Suggested release sequence

### Slice 0 — Architecture choice

Select ORM, migration approach, hosting, and deployment after reviewing RLS, transactions, cost, recovery, and team familiarity.

### Slice 1 — Identity and authority

Implement Better Auth, organization creation/invites/multiple memberships, Owner protection, controlled staff bootstrap, exclusive Admin/Finance bundles, terms history, sessions, RLS, append-only audit, and Support-case authorization.

### Slice 2 — Supplier directory, catalog, and imports

Implement private suppliers, listings, CSV/XLSX and validated fixed-endpoint public Sheets staging/review, row-level apply, listing revisions, metrics, pricing, and live control.

### Slice 3 — Wallet funding and access

Implement Stripe USD top-ups, immutable wallet ledger, $50 qualification, six-month access grants, webhook idempotency, and reconciliation.

### Slice 4 — Orders and customer content

Implement 25-item bulk checkout, wallet debit, item/placement/writing-stage snapshots, text-only content and Support requests, content policy acceptance, consent/versioning, customer order views, and pre-handoff cancellation requests.

### Slice 5 — Fulfillment and reporting

Implement assigned fulfillment, explicit item states, customer-safe milestones, minimum-data supplier handoff, live URL verification/correction, Support cases, cancellation/refund cutoffs, customer updates, supplier measures, cost records, and exports.

### Slice 6 — Production readiness

Complete legal/finance review, provider certification, security review, support runbooks, RPO/RTO, backups, and real-money launch gates.

## 5. Acceptance

Screens alone do not qualify as release readiness. Each slice must meet the security, ledger, import, idempotency, failure-recovery, reporting, privacy, and operational criteria in the canonical docs.
