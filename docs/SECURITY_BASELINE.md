# Security Baseline

**Status:** Required implementation baseline
**Scope:** Customer organizations, admin operations, supplier confidentiality, wallet integrity, imports, publication evidence, and payment integrations.

## 1. Identity and session security

- Use Better Auth with Google sign-in as the customer identity/session direction.
- Verified signup creates an organization and first Owner. Users may belong to multiple organizations with an explicit active organization context. Organization invitations are email-bound, accepted by the same verified address, expire after seven days, and default to Member. Protect the last Owner from removal until ownership is transferred.
- Require verified customer identity before catalog access and wallet funding.
- Use secure cookies, appropriate CSRF/origin checks, rate limits, safe redirects, prompt revocation, and recovery controls.
- Keep staff identity and authority separate from customer organization membership. Disable public staff signup; bootstrap the first Super Admin through a one-time controlled setup, then use Super Admin invitations. Ordinary staff hold only one of Admin or Finance; Super Admin is the only all-access role. Require MFA for staff and revoke sessions on deactivation.
- Store accepted Terms and Privacy versions, actor, and timestamp. Newsletter opt-in is separate, optional, default-off, and revocable.

## 2. Authorization and tenant isolation

- Deny by default and check current organization membership or staff permission at every sensitive read and mutation.
- Customer tenant scope is derived from active membership; never authorize by object ID alone.
- Use PostgreSQL RLS for organization-owned records with restricted runtime roles and trusted transaction-scoped tenant context. Application checks remain mandatory.
- Customer and staff responses use explicit allowlisted projections. RLS does not redact columns.
- Admin manages catalog and routine fulfillment; Finance handles restricted financial/cost work; Super Admin has broad access but cannot bypass RLS, ledger, evidence, idempotency, or audit.
- Internal JSON reports are Super Admin-only. Assigned Admin handoffs are minimum-data, purpose-bound, and audited. Gross-profit and source-cost fields require cost permission.

## 3. Marketplace access and URL confidentiality

- Compute the 15-day organization trial and paid access grants from server timestamps.
- Grant access only from verified, settled wallet credits meeting the $50 policy. Link each grant uniquely to its funding credit and policy version.
- Access is independent of wallet balance. Dispute/reversal affects only the linked grant; preserve other grant intervals.
- Check entitlement before returning catalog rows, URL, counts, search results, page metadata, hydration/prefetch data, exports, or analytics payloads.
- A public-listing flag bypasses URL concealment only while browsing is allowed. It never bypasses sign-in or the post-trial access gate.
- Do not deliver protected data behind a blur or rely on client-side route checks. Prevent shared caching of organization-specific catalog responses.

## 4. Wallet, payment, and idempotency

- Treat the wallet as an immutable ledger, never an editable balance field.
- Use exact USD minor units, atomic transactions, uniqueness constraints, and scoped idempotency for top-ups, orders, refunds, access grants, and retryable financial commands.
- Verify Stripe webhook signatures from exact request bytes and match provider account, environment, attempt, organization, amount, currency, and terminal state. Redirects do not prove payment.
- Persist provider events durably and deduplicate by provider identity. Ambiguous timeouts are reconciled before retry; never guess.
- Multi-item order creation and aggregate wallet debit commit atomically. Item refunds are compensating wallet credits and cannot exceed item retail value.
- Chargebacks hold available funds where possible, suspend linked access, and restrict spending as policy requires. Never silently mutate the ledger.
- Store provider fees separately. Do not implement supplier payout execution or customer cash-out.

## 5. Supplier, import, and content protection

- Supplier identity, contacts, source rates, source files, import values, internal notes, and source classification are confidential.
- Only Admin/authorized staff access supplier contacts for inventory or assigned fulfillment. Finance sees source costs as permitted; exports require exact role.
- CSV/XLSX and public Sheets data are untrusted. Use a maintained parser in data-only mode; bound file size, rows, worksheets, archive expansion, parsing time, and cell lengths. Reject formula cells and macro-enabled formats; never execute macros, formulas, embedded links, or external workbook references. Escape rendered values and protect CSV/XLSX exports from spreadsheet formula injection. Review/correct staged rows and apply only selected valid rows; invalid and duplicate-flagged rows remain staged. These controls are the v1 baseline; an external antivirus service is not required unless a later threat review or hosting requirement justifies it.
- Customer order details and supplements are text-only in v1; provide no customer file-upload endpoint for articles, briefs, or order evidence. Enforce field-specific length and structured-value validation, store input as data, and contextually encode it in every UI, email, EML, and PDF output. Do not interpret customer text as HTML, scripts, templates, or executable markup.
- Direct Sheets reads are limited to public/readable sources and staff-triggered staging refresh. Accept only a validated Google Sheets URL/ID and fetch through fixed Google endpoints; reject arbitrary hosts and unvalidated redirects. Never fetch URLs from cells or other user-controlled fields.
- Supplier handoff includes only the article/brief and publication instructions required for the assigned order, with customer notice/consent. Exclude name, account, and billing details.
- Keep customer article content out of logs, traces, analytics, and generic exports. Store staff import files and optional handoff evidence in private object storage, with access metadata in PostgreSQL, access audits, authenticated download-only delivery, and retention/deletion rules. Do not serve uploaded evidence as active inline content.

## 6. Supplier handoff and email

- Follow the packet boundary in [Supplier Email Handoff](SUPPLIER_HANDOFF.md): one organization/order/supplier per packet, based on the order's supplier assignment snapshot.
- Require item readiness, final approved content, recipient review, and current consent to share content with the publication-site/fulfillment partner before dispatch. Internally bind that consent to the exact content, supplier, and recipient; never expose supplier identity to the customer.
- Admin assigned to fulfillment or Super Admin may send from the configured server-side provider or export a packet for manual sending. Export is not proof of handoff.
- Persist packet version and send intent before external calls. Unknown send outcomes require reconciliation before resend; retries and webhooks are idempotent and audited.
- Verify webhook signatures and deduplicate event IDs. Keep provider acceptance/delivery distinct from supplier acknowledgement and publication completion.
- Restrict packet snapshots, manual evidence, recipient details, and article content to authorized staff. Do not place content in generic audit logs.

## 7. Metrics and publication evidence

- Metric API credentials remain in a secret store and are accessible only to the server/worker paths that need them.
- Store metric provider, scope, value, source date, refresh time, and status. Missing, stale, failed, and zero are distinct.
- Verify licensing, attribution, and redistribution terms before customer display.
- Staff verification records the live URL, timestamp, method, verifier, and evidence. Google indexing is separate and is unknown unless authorized Search Console data exists.
- Do not perform automated URL fetching until SSRF defenses are designed and reviewed.

## 8. Audit, monitoring, and retention

Audit staff permission changes, organization membership/invitation/ownership changes, fulfillment assignment changes, listing price/live changes, imports/applies, supplier-contact access, packet preparation/versioning, automatic/manual handoffs, recipient overrides, send outcomes, acknowledgements, access-policy changes, wallet postings/reversals/refunds, provider-event outcomes, cost corrections, manual supplier-paid records, Support case decisions, exports, and publication verification.

Audit records include actor, tenant/target, timestamp, action, reason, outcome, and safe correlation identifiers. Redact credentials, payment payloads, supplier secrets, customer names where not required, and article/brief content.

Audit events are append-only for all application roles, including Super Admin. Routine runtime roles cannot update or delete audit events. Correct mistakes with a new linked event; any exceptional data-retention purge must be separately authorized and leave permitted evidence of the purge.

Retain financial and audit evidence as required by law. Retain final order/publication records as needed. Customer order content is text-only, with no customer-uploaded order attachments in v1. Minimize or delete private briefs and drafts after fulfillment/dispute needs end. Apply separate access and retention controls to staff inventory uploads, staff-only handoff evidence, and GPHKM-generated packet PDFs. Set exact periods with legal/finance before production.

## 9. Security acceptance

Before real-money production, demonstrate cross-organization denial, staff-role isolation, hidden-field exclusion, active entitlement checks, webhook replay safety, exact money matching, concurrent wallet-spend safety, item refund bounds, safe import staging/export, audit delivery, backup restoration, and incident response. Test RLS with the restricted runtime identity, not a database owner.
