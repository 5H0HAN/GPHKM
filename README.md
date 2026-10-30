# GPHKM

**Project status:** Initial implementation in progress
**Document baseline:** 0.3
**Implementation status:** Slice 0 foundation underway

GPHKM is a customer-and-admin platform for reselling guest-post placements. Customer organizations browse curated listings, add multiple placements to one order, fund an organization wallet, and follow item-level publication progress. Staff own listing quality, supplier relationships, pricing, fulfillment, and financial reconciliation.

GPHKM is a new project. GuestPost.cc remains a read-only reference and is not the implementation target. Suppliers are private internal records; there are no supplier accounts, payout execution, or publisher portal in v1.

## Read in this order

1. [Project brief](docs/PROJECT_BRIEF.md)
2. [Product scope](docs/SCOPE.md)
3. [Product specification](docs/PRODUCT_SPEC.md)
4. [Money flow architecture](docs/MONEY_FLOW_ARCHITECTURE.md)
5. [Security baseline](docs/SECURITY_BASELINE.md)
6. [RBAC matrix](docs/RBAC_MATRIX.md)
7. [Domain model and data boundaries](docs/DOMAIN_MODEL.md)
8. [Threat model](docs/THREAT_MODEL.md)
9. [Architecture proposal](docs/ARCHITECTURE_PROPOSAL.md)
10. [Proposed repository structure](docs/PROJECT_STRUCTURE.md)
11. [Operations and quality standards](docs/OPERATIONS_AND_QUALITY.md)
12. [Implementation guide](docs/IMPLEMENTATION_GUIDE.md)
13. [Supplier email handoff](docs/SUPPLIER_HANDOFF.md)
14. [Open decisions](docs/OPEN_DECISIONS.md)
15. [Accepted decisions](docs/adr/README.md)

## Approved v1 direction

- One Next.js application with customer and staff areas, server-only domain modules, PostgreSQL, and Better Auth with Google sign-in.
- Stripe is the first wallet-funding provider and charges in USD. Wallet-funded order checkout is the only order payment path in v1. PayPal and other providers are later additions.
- A customer organization receives 15 days of catalog browsing. A settled top-up credit of at least $50 grants both browsing and hidden-URL access for six calendar months by default. Spending does not shorten access.
- Catalog URLs and all source/supplier classifications are hidden unless policy allows them. Customer sign-in and active marketplace access are enforced on the server.
- CSV/XLSX and public, readable Google Sheets imports enter a staff-reviewed staging workflow. Import never changes retail price or live state automatically. Supplier handoff uses per-order/per-supplier packets with dashboard email, manual EML/PDF export, audit, and reconciliation.
- Each checkout supports up to 25 distinct listings. Each item is fulfilled and tracked separately. Unknown email outcomes enter reconciliation immediately; provider acceptance without delivery confirmation after 72 hours enters delivery follow-up. Supplier acknowledgement follow-up is 72 hours after confirmed delivery or recorded manual send; these are internal targets, not supplier SLAs. Post-handoff cancellation/refund is not allowed by default; break-glass wallet refunds require a Support case and Finance or Super Admin approval.
- Customer progress is GPHKM-branded; supplier identities and sourcing details remain hidden, with neutral content-sharing disclosure at checkout. Customer Support uses a minimal text-only case workflow.
- Verified signup creates an organization; users may join multiple organizations by invitation. Staff roles are controlled, with one Admin or Finance bundle per ordinary account and a separate Super Admin.
- A listing may state a lifetime placement term. This is the publisher's intent, not a guarantee; no post-completion replacement or refund is offered if a link later disappears.
- Supplier profiles, contacts, costs, and performance are internal. No supplier login or payout execution is in scope.
- Real-money checkout remains disabled until the U.S. state/entity, provider account details, and qualified legal/finance review are complete.

## Review and implementation rule

The product behavior and security controls in these docs are the implementation baseline. Decisions awaiting technical validation or a launch-time value are listed in [Open decisions](docs/OPEN_DECISIONS.md). Do not silently add services, generalized frameworks, payout flows, or customer-visible supplier data. The initial local stack is recorded in [ADR-0010](docs/adr/ADR-0010-initial-development-stack.md); production connection and real-money gates remain open.

## Local development

1. Copy `.env.example` to `.env`. Choose two random local passwords: reuse the migration password in `POSTGRES_MIGRATION_PASSWORD` and `MIGRATION_DATABASE_URL`, and the runtime password in `GPHKM_DATABASE_PASSWORD` and `DATABASE_URL`. Keep `.env` private.
2. Start the database with `docker compose up -d db`.
3. Install packages with `npm install`, then run `npm run dev`.

The database is exposed only on `127.0.0.1:54329`. `DATABASE_URL` uses the non-superuser runtime role; `MIGRATION_DATABASE_URL` uses the separate local migration role. The PostgreSQL volume persists across restarts. To intentionally reset this empty development database, use `docker compose down -v`.
