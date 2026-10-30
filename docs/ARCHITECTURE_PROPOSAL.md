# Architecture Proposal

**Status:** Approved direction; ORM, hosting, and deployment details remain for Slice 0
**Scope:** Proportionate initial system for customer organizations and staff

## 1. Design direction

Use one Next.js codebase and PostgreSQL, with distinct customer and staff/admin entry points on separate subdomains. The two subdomains have separate login pages and host-only browser sessions. Keep server-only domain modules and Better Auth with Google sign-in for identity; subdomain separation is not an authorization boundary. PostgreSQL is the system of record for organization data, access grants, wallet ledger, orders, audit, and workflow state.

The app server owns authorization and business commands. PostgreSQL constraints and focused row-level security provide a second tenant boundary. Customer and staff projections are explicit and separate. Keep one codebase and shared domain modules by default; whether both hostnames use one deployment or separate deployments remains open. Do not start with a separate API service or microservices.

Add one lightweight worker using database-backed jobs/outbox only when reliable retries or scheduled execution are needed for Stripe events, Sheets imports, metric refreshes, or notifications. Do not add Redis or multiple worker lanes initially. The app may process simple synchronous work until durable background execution is justified.

Drizzle/Drizzle Kit and local Docker PostgreSQL are accepted for initial development in [ADR-0010](adr/ADR-0010-initial-development-stack.md). Coolify + Neon remain the preferred production direction, subject to the RLS, transaction, cost, region, and recovery checks in O-01. Use a direct migration connection. Resend is the preferred email candidate pending O-05 checks. Use private object storage for staff imports and optional handoff evidence; select the provider before that integration.

## 2. Logical shape

    customer.<domain>       staff.<domain>
              \             /
           Next.js app entry points
                    |
            server domain modules
       |           |
    Better Auth   PostgreSQL
       |           |
    Stripe USD   Durable jobs when needed
                    |
             One lightweight worker
                    |
         Sheets, metric APIs, notifications

Stripe is the only enabled payment provider for v1. Keep a small provider boundary so PayPal can be added after the Stripe flow is proven; do not build future provider adapters or a generalized capability framework now.

Use exact approved origins for each environment. Keep Better Auth cross-subdomain cookies disabled so the browser holds host-only sessions; do not use a parent-domain cookie to make login appear shared. Customer and staff sign-in must be routed to their own hostname, while server-side organization membership, staff role, MFA, assignment, and permission checks remain mandatory on every protected request. Hostnames, OAuth callback URLs, and whether the deployment is shared are tracked in O-06.

## 3. Server-side modules

Keep cohesive modules inside the application:

- Identity, organization membership, staff access, and terms acceptance.
- Catalog, listing revisions, supplier records, metric observations, and imports.
- Wallet, Stripe funding attempts, webhook inbox, ledger, and reconciliation.
- Orders, item-level workflow, writing add-on, supplier handoff, and publication evidence.
- Notifications, audit, and reporting.

Modules may have clear command/query boundaries without becoming separate packages or services. Extract a package only after real reuse or an operational boundary exists.

## 4. Data and transaction boundaries

- Organization owns membership, wallet, access grants, orders, and billing context.
- A qualifying settled Stripe top-up creates its wallet credit and linked access grant atomically and idempotently.
- Multi-item checkout revalidates all listings, snapshots terms, creates all items and item events, and posts one total wallet debit in a single transaction. It either commits fully or has no effect.
- Provider webhooks are verified, durably recorded, matched to an attempt, and processed idempotently. Browser redirects are status views, not evidence of payment.
- Listing source, supplier identity, supplier contacts, source costs, staff notes, and supplier performance never enter customer projections.
- External calls do not occur inside retryable database transactions. Persist intent first; retry with stable idempotency identities.

## 5. Imports and external metrics

CSV/XLSX uploads and direct reads of public/readable Google Sheets enter a staging workflow. Staff-triggered refreshes never auto-publish or change retail price/live state. Do not fetch arbitrary user-provided URLs. Open PageRank is the first implemented metric boundary, using its fixed server-side endpoint. Ahrefs and Moz integrations wait until keys and provider checks are available. Display each metric only after current license, attribution, redistribution, and cost review.

## 6. Reliability and operations

Persist payment events, import batches, notification intent, and other work before retrying. A worker is added when DB-backed durable work needs independent execution; queue messages are wakeups, not the only record of work. Keep retries bounded and handlers idempotent.

Define backups, recovery, monitoring, object-storage controls, support hours, and RPO/RTO before production. Provider downtime must not cause guessed wallet credits or duplicate orders.

## 7. Decisions intentionally deferred

ADR-0010 selects the initial ORM and local migration approach. The production hosting, Neon connection mode, and recovery details remain open under O-01. Provider/account setup and legal/finance review remain gates before real-money production. Future scale does not justify a separate API, Redis, microservices, a supplier portal, or payout infrastructure at this stage.
