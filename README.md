# GPHKM

**Project status:** Local v1 implementation in progress
**Document baseline:** 0.3
**Implementation status:** The local v1 build is in progress through migration 0132. Customer and staff workflows, secure invitation acceptance with a gated delivery outbox, supplier operations, customer-approved equivalent offers, Finance reconciliation across original and accepted supplier routes, private supplier-transfer receipts, per-user theme preferences, organization closure, narrow database-enforced identity transitions, bounded Stripe Checkout Session retries, customer-safe order milestone history, audited Super Admin access-policy controls, Owner-only billing profiles, current-observation metric redistribution attestations with an external L-05 display gate, audit/support/notification/cancellation/closure pagination, supplier-to-fulfillment identity enforcement, item-specific supplier notices, Resend event correlation, isolated provider database roles, versioned acceptable-content policy acceptance at checkout, paginated Finance gross-profit reporting, and the restricted-role RLS smoke check are implemented locally. CI migrates an ephemeral PostgreSQL database, runs the rollback-only RLS smoke check under the restricted runtime role, and exercises customer session isolation plus staff MFA over HTTP. Remaining end-to-end gaps and launch gates are listed in the [Implementation Guide](docs/IMPLEMENTATION_GUIDE.md). Real-money checkout and external provider delivery remain gated.

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
14. [Open PageRank provider boundary](docs/OPEN_PAGE_RANK.md)
15. [Open decisions](docs/OPEN_DECISIONS.md)
16. [Accepted decisions](docs/adr/README.md)

## Approved v1 direction

- One Next.js codebase with customer and staff/Admin areas on separate subdomains, server-only domain modules, PostgreSQL, and Better Auth. Customers can use Google or verified email/password; staff provisioning and MFA stay separate. Sessions remain host-only; exact hostnames and deployment topology are open in O-06.
- Stripe is the first wallet-funding provider and charges in USD. Wallet-funded order checkout is the only order payment path in v1. PayPal and other providers are later additions.
- A customer organization receives 15 days of catalog browsing. A settled top-up credit of at least $50 grants both browsing and hidden-URL access for six calendar months by default. Spending does not shorten access.
- Catalog URLs and all source/supplier classifications are hidden unless policy allows them. Customer sign-in and active marketplace access are enforced on the server.
- CSV/XLSX and public, readable Google Sheets imports enter a staff-reviewed staging workflow. Import never changes retail price or live state automatically. Supplier handoff uses per-order/per-supplier packets with dashboard email, manual EML/PDF export, audit, and reconciliation.
- Each checkout supports up to 25 distinct listings. Each item is fulfilled and tracked separately. Unknown email outcomes enter reconciliation immediately; provider acceptance without delivery confirmation after 72 hours enters delivery follow-up. Supplier acknowledgement follow-up is 72 hours after confirmed delivery or recorded manual send; these are internal targets, not supplier SLAs. Post-handoff cancellation/refund is not allowed by default; break-glass wallet refunds require a Support case and Finance or Super Admin approval.
- Customer progress is GPHKM-branded; supplier identities and sourcing details remain hidden, with neutral content-sharing disclosure at checkout. Customer Support uses a minimal text-only case workflow.
- Verified signup creates an organization; users may join multiple organizations by invitation. Customer recovery relies on Google. Owners may store an optional legal name, billing email, and billing address; staff and suppliers cannot see these fields. Staff roles are controlled, with one Admin or Finance bundle per ordinary account and a separate Super Admin.
- A listing may state a lifetime placement term. This is the publisher's intent, not a guarantee; no post-completion replacement or refund is offered if a link later disappears.
- Supplier profiles, contacts, costs, and performance are internal. No supplier login or payout execution is in scope.
- Real-money checkout remains disabled until the U.S. state/entity, provider account details, and qualified legal/finance review are complete.

Local wallet funding is available only when Stripe test credentials and the matching test webhook are configured; without them, the recharge page stays unavailable and existing wallet/order features continue to work. Live mode requires a restricted `rk_live_` server key, a matching live publishable key and webhook, verified required key scopes/IP restrictions, and both `GPHKM_REAL_MONEY_ENABLED=true` and `GPHKM_LAUNCH_GATES_VERIFIED=true`; setting the latter is an operator assertion made only after the documented gates have been evidenced and approved. Keep both flags false until then. Open PageRank refresh likewise requires `OPEN_PAGE_RANK_API_KEY` in the private server environment; customer metric display remains disabled until the L-05 rights review is cleared.

## Review and implementation rule

The product behavior and security controls in these docs are the implementation baseline. Decisions awaiting technical validation or a launch-time value are listed in [Open decisions](docs/OPEN_DECISIONS.md). Do not silently add services, generalized frameworks, payout flows, or customer-visible supplier data. The initial local stack is recorded in [ADR-0010](docs/adr/ADR-0010-initial-development-stack.md); production connection and real-money gates remain open.

## Local development

1. Copy `.env.example` to `.env`. Generate different random passwords for migration, runtime, worker, Stripe webhook, Resend webhook, and MFA-proof database roles, and keep each URL in sync. For local auth, set `GPHKM_LOCAL_AUTH_ENABLED=true`, generate `BETTER_AUTH_SECRET` and both test passwords, and use separate reserved `.test` emails. To skip staff MFA only during local UI testing, set `GPHKM_LOCAL_MFA_DISABLED=true`; it requires development mode and local authentication, and is rejected elsewhere. Local-only placeholder Terms/Privacy pages may be used to exercise consent; they are explicitly nonbinding. Customer signup and protected actions fail closed without configured document URLs and versions. Production credential signup and reset also require approved Resend configuration. Keep `.env` private.
2. Start the database with `docker compose up -d db`, then install packages with `npm install`.
3. Run `npm run roles:provision-local` to create/update the application, worker, Stripe webhook, Resend webhook, and MFA-proof roles on an existing local volume.
4. Apply the schema with `npm run db:migrate`.
5. Run `npm run db:check-rls:local` to check tenant filtering and direct-write restrictions under `gphkm_runtime`; it rolls back its synthetic fixtures.
6. Create the two local-only test identities once with `NODE_ENV=development npm run auth:bootstrap:local`.
7. Start the app with `npm run dev`. `http://localhost:3000` is the public product page; its only sign-in action opens the configured customer host. Open `http://customer.localhost:3000` for the customer workspace and `http://staff.localhost:3000` for the staff workspace. Sign in using the fixture values kept in `.env`; staff MFA is skipped only if the local bypass is explicitly enabled.
8. With the app running, optionally run `npm run db:check-session-guard:local`. It signs in the local customer fixture, verifies host-bound sign-in session projections, confirms a forwarded customer cookie cannot reveal the customer identity on the staff sign-in page, verifies customer access and staff page/API denial, ages only that temporary session, verifies that all direct Better Auth revocation endpoints reject it, then deletes the temporary session. The check is development-only and refuses non-loopback hosts.
9. Optionally run `npm run db:check-staff-mfa:local` with `GPHKM_LOCAL_MFA_DISABLED=false` and the dev server restarted. It creates and deletes a temporary `.test` staff identity, verifies TOTP enrollment and the exact-session MFA proof, checks staff console access before and after proof, and confirms a forwarded staff cookie is rejected on customer surfaces. The check is development-only and refuses non-loopback hosts.

The database is exposed only on `127.0.0.1:54329`. `DATABASE_URL` uses the non-superuser request runtime role; `MIGRATION_DATABASE_URL` uses the separate local migration role. Stripe webhooks, Resend webhooks, and verified MFA proof writes use separate, narrowly granted database roles; none inherits the request runtime role. Provision local role credentials after Docker PostgreSQL is ready and before applying migrations. The PostgreSQL volume persists across restarts. To intentionally reset this development database and its one-time test identities, use `docker compose down -v`.
