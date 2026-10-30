# Open Decisions and Launch Gates

Approved behavior is recorded in the product, money, security, RBAC, and domain documents. Accepted architecture and commercial decisions are indexed in [the ADR directory](adr/README.md). This file contains only decisions that still require evidence, an assigned owner, or launch-time values.

## Decisions deferred to Slice 0

| ID | Decision | Required input | Gate |
|---|---|---|---|
| O-01 | Production database connection, hosting, deployment, and recovery | Initial stack (Next.js, Drizzle/Drizzle Kit, local Docker PostgreSQL) is recorded in [ADR-0010](adr/ADR-0010-initial-development-stack.md). Validate Neon RLS context with the chosen connection mode, atomic transactions, Better Auth migrations, cost, connection limits, region, backups, and restore. | Before production deployment; prove tenant isolation before tenant-scoped domain features and money paths |
| O-02 | Object-storage provider and access/retention controls | Private object storage is selected as the storage pattern for staff imports and optional `.eml`/PDF evidence. Select provider, private bucket policy, authenticated download flow, lifecycle, and backup strategy. | Before file-storage integration |
| O-03 | Funding and order risk limits | Finance/provider review to set any maximum top-up, velocity, and order limits | Before enabling real-money checkout |
| O-04 | Supplier packet size limits | Set maximum email body and optional PDF attachment size; define the staff exception path for oversized packets | Before handoff implementation |
| O-05 | Transactional email provider and sender-domain setup | Resend is preferred pending account, sender-domain, deliverability, webhook-signature, retention, and data-handling checks | Before automatic supplier email send |

## Required before real-money production

| ID | Decision or evidence | Gate |
|---|---|---|
| L-01 | U.S. operating state and legal entity | Before accepting real money |
| L-02 | Stripe account, merchant configuration, and provider-specific callback/reconciliation details | Before accepting real money |
| L-03 | Qualified legal and finance review of wallet terms, customer terms, privacy, refunds, non-expiring balances, no voluntary cash-out, and required legal/processor exceptions | Before accepting real money |
| L-04 | Final customer-facing wording for lifetime placement terms and no post-publication remedy | Before selling listings |
| L-05 | Current metric-provider licensing, attribution, redistribution rights, API access, and cost for each metric displayed to customers | Before enabling that metric for customer display |
| L-06 | Support hours, operational response promise, and RPO/RTO | Before production launch |
| L-07 | Listing-specific writing prices, turnaround estimates, and disclosed partial-refund rules where writing is offered | Before publishing an eligible writing add-on |
| L-08 | Final acceptable-content rules and customer disclosure wording; publish platform-wide and listing-specific content rules, and legally review customer rights confirmation, publication-site/partner sharing notice, sensitive-topic review, and no SEO/ranking guarantee | Before selling listings |
| L-09 | Exact retention/deletion periods and any legally required closure exceptions; Legal/Finance set periods for order content, Support cases, financial/audit evidence, import files, and handoff evidence | Before production |

## Resolved decisions

- US and USD for v1; Stripe charges in USD. Foreign card issuers handle their own conversion and fees.
- Wallet funding only; order checkout spends wallet funds. No direct payment-method order capture or split tender.
- Initial qualifying wallet credit is $50. One settled top-up must meet the threshold; access starts when settlement is confirmed.
- Initial access grant is six calendar months; the audited platform-wide duration policy supports six months, one year, or unrestricted access and applies to future grants. Each grant snapshots its policy version and recorded interval.
- Access is independent of wallet balance. Each qualifying top-up creates its own linked grant. Finite grants extend from the later of the latest recorded finite expiry or settlement. If an unrestricted grant is active, another top-up creates a separate grant at settlement under the current policy without changing existing intervals. Grants retain their dates if another is revoked.
- A pending dispute suspends only the linked grant. A lost dispute/reversal revokes only that grant; a won dispute restores it with its original expiry.
- Wallet balances do not expire. No voluntary customer cash-out; order-item cancellation refunds return to the organization wallet, subject to legal or processor-required exceptions.
- Owners manage organization funding, settings, and members and see shared orders and recharge history. Members can order, see their own orders, and see balance/sufficiency, but not recharge history.
- Verified signup creates an organization and its first Owner. Users may belong to multiple organizations; joining others requires a verified-email invitation. Invitations expire after seven days and default to Member. Owners may create co-Owners; the last Owner must transfer ownership before leaving/removal. Organization closure is Support-managed and waits until active orders/disputes are resolved and the wallet balance is zero, except for legally required exceptions; no voluntary cash-out.
- Public staff signup is disabled. Bootstrap the first Super Admin through one controlled setup procedure. Super Admin invites staff; ordinary staff hold one Admin or Finance role bundle, with MFA and session revocation on deactivation.
- Catalog requires verified sign-in. A listing's public URL flag bypasses only URL concealment, never the trial or paid browsing requirement.
- One offer per listing, one placement per selected listing, maximum 25 distinct listings per checkout. The checkout retail price is fixed on an existing order; source-cost variance updates actual margin only, and listing retail repricing applies to future orders.
- Customer-provided article is the default. Optional GPHKM writing is a paid, listing-configured add-on with a customer brief, draft approval, and one included revision.
- Placement and optional writing charges are separate snapshots. Writing fees use two Admin-configured, customer-disclosed stages (complete first draft and final draft after the included revision); approval of the first draft without a requested revision completes both stages. Only undelivered stage amounts are refundable under the listing's policy.
- Customers may request pre-handoff content changes for assigned Admin approval. Approved changes create a new content/packet version and require renewed consent; after handoff, changes are separate supplier messages.
- Customer order and Support fields are text-only. Customer-facing statuses are GPHKM-branded and hide supplier/source identity, while checkout neutrally discloses that approved content and instructions are shared with the publication site/partner. Customers confirm rights to content. Illegal/abusive, phishing/malware, unlicensed, and listing-prohibited content may be held/rejected; sensitive legal topics receive Admin review.
- Customer order details, articles, briefs, and supplements are text-only in v1. Customer order uploads/attachments are excluded; staff imports/evidence and GPHKM-generated supplier PDFs are separate workflows. Spreadsheet imports use bounded, data-only parsing without an external antivirus service in v1; formula cells and macro-enabled formats are rejected, and rendered/exported values are safely escaped.
- Customer-facing supplier identities and source classifications are prohibited. Commercial source and fulfillment contact are separate concepts.
- CSV/XLSX uploads and staff-triggered refresh of public/readable Google Sheets both enter staging and require review/apply.
- Sheet imports accept only validated Google Sheets references fetched through fixed Google endpoints. Staff review and apply selected valid rows; invalid and duplicate-flagged rows remain staged. Never fetch URLs from cells.
- Audit events are append-only for all roles including Super Admin; corrections are linked new events. Admin or Super Admin assigns/reassigns order items; only the assigned Admin accesses item content/evidence.
- Domain metric refresh is staff-triggered and batched first. Supplier reporting uses transparent trailing-90-day measures with sample size; no weighted score.
- Super Admin alone may export internal JSON reports. Assigned Admin/Super Admin may create a supplier-specific handoff. A manual export is not a handoff until staff records actual send details/evidence. Finance or Super Admin may record manual supplier-paid status with evidence and audit.
- Handoff is tracked per order item and supplier packet. Dashboard email puts the packet in the body with an optional selectable-text PDF attachment; manual downloads are ready-to-send EML or PDF. Provider acceptance/delivery is separate from supplier acknowledgement. Unknown send outcomes are reconciled before deliberate resend; unrelated supplier packets continue independently. The initial internal supplier-acknowledgement follow-up target is 72 hours after provider-confirmed delivery or staff-recorded manual handoff, not a supplier SLA; staff may set a different next-update date and set later follow-ups case by case.
- Unknown send outcomes enter reconciliation immediately and block resend. Provider acceptance without delivery confirmation after 72 hours enters delivery follow-up. The supplier-acknowledgement timer begins 72 hours after provider-confirmed delivery or staff-recorded manual handoff. Customer-facing Publication in Progress begins after delivery confirmation/manual handoff for supplier email, or assigned staff-recorded work start for internal fulfillment.
- Admin reviews and may approve rule-based pre-handoff cancellations; system credits the exact eligible amount to the organization wallet. Supplier email handoff cutoff is provider acceptance or staff-recorded manual send, not packet export. Internal fulfillment cutoff is when assigned staff records work start. After cutoff, ordinary cancellation/refund is not allowed; a Support case is required, and Finance/Super Admin may approve a documented wallet exception. Supplier failure is not an automatic refund.
- Support uses a minimal order/item-linked case workflow: Open, Investigating, Waiting on Customer/Supplier, Finance Review, Resolved/Closed. Owner sees all organization cases; Members see cases they opened or tied to their orders. Case opener receives in-app and transactional email for customer-visible updates; internal notes and Finance decisions remain private. Organization closure is Support-managed.
- If completion was incorrectly verified, assigned Admin or Super Admin may open an audited correction case while preserving original evidence; this does not apply to a later disappearance after valid completion.
- Staff verifies a live URL to complete an item. Google indexing is separate and unknown unless authorized Search Console data is available.
- A lifetime listing means the publisher intends to keep a placement live indefinitely; GPHKM does not guarantee continued availability. After valid completion, later link disappearance does not create a replacement or refund entitlement. Record and explain a known cause without rewriting completion evidence.
- Admin handles routine catalog, fulfillment, and support. Finance actions are restricted. Super Admin can access all areas but cannot bypass ledger, evidence, RLS, or audit requirements.
- Retain final article/order records as needed. Minimize or delete private briefs and drafts after fulfillment/dispute needs end; retain financial and audit evidence according to law. Customer order uploads are not supported; staff imports and optional handoff evidence use private object storage; generated packet PDFs derive from frozen text snapshots.
- Use Drizzle/Drizzle Kit and local Docker PostgreSQL for initial development as recorded in ADR-0010. Keep Coolify + Neon as the production direction pending O-01 validation, with TLS, separate runtime/migration credentials, pooled connections only after RLS-context validation, and direct migration connections. Resend is preferred pending O-05 checks. Start with redacted structured logs and actionable host/database/provider health alerts; no separate monitoring service until the chosen setup needs it. Add one database-backed worker/outbox only when durable background work is needed; no Redis or multiple worker lanes initially.

## Change control

When a deferred choice is resolved, update this file and the canonical specification. Record material, long-lived decisions in a short ADR. Recommendations are not approvals.
