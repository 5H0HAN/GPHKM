# Implementation Guide

**Purpose:** Give the team a minimal, reviewable implementation sequence.

## 1. Approved starting architecture

Use one Next.js customer/admin application, PostgreSQL, and Better Auth with Google sign-in. Keep domain logic server-side. Add one database-backed worker/outbox only when durable retryable or scheduled work is required. Do not introduce Redis, multiple worker lanes, separate API/UI deployments, or microservices without evidence that the simpler design no longer works.

Drizzle/Drizzle Kit and local Docker PostgreSQL are accepted for initial development in [ADR-0010](adr/ADR-0010-initial-development-stack.md). Coolify + Neon remain the preferred production direction, subject to the RLS, transaction, cost, and recovery proof in O-01. Use a direct migration connection. Resend is the preferred supplier email provider pending account, sender-domain, webhook, deliverability, and data-handling checks. Private object storage is the file-storage pattern; provider remains open.

## 2. Build slices

### Slice 0 — Architecture and repository foundation

Record and validate the ORM, PostgreSQL access/RLS strategy, hosting, migrations, environments, secrets, backups, and local setup. The initial local stack is recorded in ADR-0010. Keep production deployment selection open until O-01's Neon, recovery, cost, and RLS checks are completed. Establish CI and staging after the toolchain is operational.

**Exit:** a reproducible local setup, restricted runtime identity, reviewable migration path, and documented production deployment choice with tested recovery plan. The first two are underway; production remains open.

### Slice 1 — Identity, organization, staff authority

Implement Better Auth with Google sign-in, verified customer identity, revocable sessions, customer profiles, organization creation/invites/multiple memberships/Owner transfer, controlled first Super Admin bootstrap, exclusive Admin/Finance role bundles, terms acceptance history, optional newsletter consent, append-only audit, Support-case access, and database tenant isolation.

**Exit:** cross-organization reads/writes fail closed; revocation is prompt; role and field boundaries are enforced server-side and under the restricted database runtime role.

### Slice 2 — Supplier directory, catalog, and staging

Implement private supplier contacts, listing revisions, retail pricing, explicit live/pause controls, CSV/XLSX upload, public/readable Google Sheets staging through validated IDs and fixed endpoints, row validation, duplicate review, selected-row apply, metric observations, and audit. Apply imports only after staff review.

**Exit:** no import can publish a listing or change retail price/live state automatically; customer projections exclude supplier/source fields and unauthorized URLs.

### Slice 3 — Wallet funding and access grants

Implement an immutable organization wallet ledger, Stripe USD funding attempt, verified/deduplicated webhook handling, reconciliation, $50 qualifying top-up policy, and linked six-calendar-month access grants using UTC month arithmetic with end-of-month clamping. Keep access independent of remaining balance.

**Exit:** retries cannot duplicate wallet credit or grants; exact amount/currency/provider evidence is required; disputes and reversals affect only the linked grant as specified; wallet history remains available after catalog access expires.

### Slice 4 — Multi-listing orders

Implement cart validation for at most 25 distinct listings, one placement per listing, separate placement/writing snapshots and disclosed writing stages, text-only content/Support forms, content rights policy and neutral publication-partner consent, customer content change requests, and one atomic wallet debit for the parent order.

**Exit:** no partial checkout or debit; changed/unavailable items require customer review; item histories remain independent.

### Slice 5 — Fulfillment, evidence, and reporting

Implement assigned fulfillment with explicit item transitions, the packet lifecycle, item-level readiness, exact recipient/content preview, server-side provider send, manual export/attestation/evidence, supplier acknowledgement, delivery-event reconciliation, and exception queue defined in [Supplier Email Handoff](SUPPLIER_HANDOFF.md). Add customer-safe milestones, Support cases, live URL verification/correction, cancellation cutoffs, policy-based pre-handoff refunds, post-handoff exception review, supplier paid/unpaid evidence, and trailing-90-day measures.

**Exit:** no silent substitution; supplier identity remains private; internal JSON exports are Super Admin-only; post-completion link disappearance creates no replacement/refund entitlement; cost/margin stays provisional until actual costs are recorded.

### Slice 6 — Production readiness

Complete provider certification, security and threat-model review, qualified legal/finance review, support runbooks, monitoring, backup restore, rate/volume limits, and real-money launch gates.

**Exit:** real-money checkout remains disabled until the state/entity, provider account, and legal/finance requirements in OPEN_DECISIONS.md are resolved.

## 3. Implementation rules

- Never trust browser-supplied price, total, role, wallet balance, supplier assignment, entitlement, or order status.
- Recheck active organization membership and staff permission for each sensitive read and command. Enforce item-level assignment before exposing order content/evidence.
- Keep exact money, immutable ledger entries, scoped idempotency, atomic transactions, and database uniqueness.
- Do not make external calls inside retryable database transactions. Persist work and retry with stable idempotency.
- Keep customer, supplier, finance, and admin data projections separate and allowlisted.
- Keep internal fulfillment states and packet transport states separate from customer-visible GPHKM-branded milestones; never expose supplier identity or source classification.
- Do not use UI route visibility as authorization. RLS is defense in depth, not a substitute for application checks.
- Do not add generalized workflow engines, permission builders, payout modules, or status override commands without a concrete approved need.
- Keep each security, money, import/export, or publication policy in one canonical document and link to it elsewhere.

## 4. Documentation and rollout

A material policy or architecture change updates its canonical document and ADR. Implementation changes require tests, security review, staging rehearsal, monitoring, and recovery planning. Implementation began on 2026-10-28 after the project owner authorized coding and local Docker use.
