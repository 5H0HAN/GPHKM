# GPHKM

**Project status:** Isolated demo staging is deployed; production launch remains gated
**Document baseline:** 0.3
**Implementation status:** The authentication migration set extends through 0197 for mandatory staff TOTP, exact-session proof, and factor reset; staff login is invitation-bound email/password plus TOTP or a one-time backup code. Migration 0192 allows provider-confirmed delivery or a recorded actual manual packet send for the current route to advance placement work, while keeping supplier receipt acknowledgement separate. Migrations 0187–0191 harden checkout evidence, approved content context, supplier notice scope, disclosure versions, and required content-policy acceptance. Migration 0186 corrects recovery-offer eligibility, preserves matching customer re-consent after packet preparation, and checks Super Admin authority against the staff table. Migration 0171 adds audited Super Admin same-supplier recovery for eligible pre-handoff supplier failures. Migrations 0141–0143 add audited removal of unapplied staged batches, row-specific supplier-category selection, and saved row-level retail prices for single-row, selected-row, and whole-batch draft creation with website conflict review. Migrations 0144–0145 add the Admin/Super Admin customer directory, audited account and membership controls, and an audited read-only projection of shared organization wallet balances. Migrations 0146–0148 add indexed customer search and page-bounded detail aggregation; 0151 caps directory pagination at 100,000 matches. Migrations 0149–0150 add durable private-file upload and cleanup state, and 0152 serializes delete queueing with concurrent file linking. Earlier migrations serialize consent with handoff, scope fulfillment writes to assigned Admins/Super Admins, harden Stripe recovery and cancellation, and serialize assignment against staff authority changes. Current verification and remaining implementation/launch gates are recorded in the [Implementation Guide](docs/IMPLEMENTATION_GUIDE.md). Real-money checkout and external provider delivery remain gated.

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
17. [Frontend UX workflow](docs/FRONTEND_UX_WORKFLOW.md)

## Approved v1 direction

- One Next.js codebase with customer and staff/Admin areas on separate subdomains, server-only domain modules, PostgreSQL, and Better Auth. Customers use Google or verified email/password, with optional authenticator verification after adding a password. Staff use invitation-bound email/password plus mandatory TOTP or a one-time backup code. A Super Admin activates invited staff after verified email and factor enrollment. Password-only staff testing is available only with the development/local-auth bypass. The staff host supports password reset by email and has no Google sign-in. See [ADR-0036](docs/adr/ADR-0036-staff-authentication-mandatory-totp.md).
- Stripe is the first wallet-funding provider and charges in USD. Wallet-funded order checkout is the only order payment path in v1. PayPal and other providers are later additions.
- A customer organization receives 15 days of catalog browsing. A settled top-up credit of at least $50 grants both browsing and hidden-URL access for six calendar months by default. Spending does not shorten access.
- Catalog URLs and all source/supplier classifications are hidden unless policy allows them. Customer sign-in and active marketplace access are enforced on the server.
- CSV/XLSX and public, readable Google Sheets imports enter staff-reviewed staging. Supplier category labels stay as source data while staff selects GPHKM categories per row; saved retail prices and website conflict checks support a single row, selected rows, or all ready, priced rows across the batch. Import never changes live state automatically. Supplier handoff uses per-order/per-supplier packets with dashboard email, manual EML/PDF export, audit, and reconciliation.
- Each checkout supports up to 25 distinct listings. Each item is fulfilled and tracked separately. Unknown email outcomes enter reconciliation immediately; provider acceptance without delivery confirmation after 72 hours enters delivery follow-up. Supplier acknowledgement follow-up is 72 hours after confirmed delivery or recorded manual send; these are internal targets, not supplier SLAs. Post-handoff cancellation/refund is not allowed by default; break-glass wallet refunds require a Support case and Finance or Super Admin approval.
- Customer progress is GPHKM-branded; supplier identities and sourcing details remain hidden, with neutral content-sharing disclosure at checkout. Customer Support uses a minimal text-only case workflow.
- Verified signup creates an organization; users may join multiple organizations by invitation. Credential customers reset passwords by email and recover a lost authenticator with a backup code. Customers who only use Google rely on Google recovery. Owners may store an optional legal name, billing email, and billing address; staff and suppliers cannot see these fields. Staff roles are controlled, with one Admin or Finance bundle per ordinary account and a separate Super Admin.
- A listing may state a lifetime placement term. This is the publisher's intent, not a guarantee; no post-completion replacement or refund is offered if a link later disappears.
- Supplier profiles, contacts, costs, and performance are internal. No supplier login or payout execution is in scope.
- Real-money checkout remains disabled until the U.S. state/entity, provider account details, and qualified legal/finance review are complete.

Local wallet funding is available only when a restricted Stripe test key and matching test webhook are configured; without them, the recharge page stays unavailable and existing wallet/order features continue to work. Follow the [Stripe sandbox wallet-funding runbook](docs/STRIPE_SANDBOX_RUNBOOK.md) for the required permissions, local event forwarding, and test-card flow. Live mode requires a restricted `rk_live_` server key, a matching live publishable key and webhook, verified required key scopes/access policy, and both `GPHKM_REAL_MONEY_ENABLED=true` and `GPHKM_LAUNCH_GATES_VERIFIED=true`; setting the latter is an operator assertion made only after the documented gates have been evidenced and approved. Keep both flags false until then. Open PageRank refresh likewise requires `OPEN_PAGE_RANK_API_KEY` in the private server environment; customer metric display remains disabled until the L-05 rights review is cleared.

## Review and implementation rule

The product behavior and security controls in these docs are the implementation baseline. Decisions awaiting technical validation or a launch-time value are listed in [Open decisions](docs/OPEN_DECISIONS.md). Do not silently add services, generalized frameworks, payout flows, or customer-visible supplier data. The initial local stack is recorded in [ADR-0010](docs/adr/ADR-0010-initial-development-stack.md); production connection and real-money gates remain open.

## Authentication configuration

`CUSTOMER_APP_URL` and `STAFF_APP_URL` are the canonical browser origins. Production requires HTTPS and separate hostnames. Register Google OAuth at the customer origin's `/api/auth/callback/google`. Invitation links, reset links, and host-only cookies stay on their respective app origins. `GPHKM_PUBLIC_BASE_URL` is the provider webhook and readiness ingress. A distinct public host serves the landing page, static assets, readiness and the signed provider webhook routes. Auth stays on the dedicated customer and staff hosts. `APP_URL`, `STAFF_URL`, `CUSTOMER_URL`, and `BETTER_AUTH_URL` are rejected.

### Google OAuth setup

Google sign-in is customer-only and requests identity scopes only (`openid`, `email`, and `profile`). For local verification, use the dedicated `GPHKM Staging` Google Cloud project, not an unrelated project. The local web client must allow the origin `http://localhost:3000` and callback `http://localhost:3000/api/auth/callback/google`. Keep its credentials in the ignored local `.env`; use a secret manager for deployed environments and never commit either value.

Before creating the local client, configure Google Auth Platform Branding with a monitored user-support email and keep the app in Testing while verifying locally. Production needs a separate Google Cloud project, approved support contact and legal URLs, and the final HTTPS customer origin before its callback is registered. Google recommends separate projects for separate deployment tiers; see [Google OAuth production readiness](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview).

Staff proof writes use `MFA_PROOF_DATABASE_URL` with the restricted `gphkm_mfa_proof` role; do not point it at `DATABASE_URL`. `GPHKM_LOCAL_MFA_DISABLED=true` is accepted only with `NODE_ENV=development` and `GPHKM_LOCAL_AUTH_ENABLED=true`.

Store and back up a stable `BETTER_AUTH_SECRET` in the secret manager. Changing it invalidates enrolled TOTP secrets and backup codes. Follow the [auth recovery runbook](docs/OPERATIONS_AND_QUALITY.md#auth-recovery) for staff recovery and the local [verification commands](docs/IMPLEMENTATION_GUIDE.md#auth-verification).

## Demo staging

Coolify deploys the GitHub App’s `main` branch using [the staging Compose definition](compose.staging.yaml). The [staging runbook](docs/STAGING.md) covers origins, provider setup, migration, safe seeds and operator bootstrap. Designated Google testers can accept preliminary notices on the customer host and use the Stripe sandbox.

## Local development

1. Copy `.env.example` to `.env`. Generate different random passwords for migration, runtime, worker, Stripe webhook, Resend webhook, and the reserved MFA proof database roles, and keep each URL in sync. Locally, customer auth uses `http://localhost:3000` and staff auth stays on `http://staff.localhost:3000`. For local auth, set `GPHKM_LOCAL_AUTH_ENABLED=true`, generate `BETTER_AUTH_SECRET` and both test passwords, and use separate reserved `.test` emails. The exact customer fixture `client@guestpost.local` is also accepted for local bootstrap only; it is preverified and is not a deliverable mail address. Email signup is off by default; to exercise it locally, also set `GPHKM_LOCAL_CUSTOMER_EMAIL_SIGNUP_ENABLED=true` and configure approved Resend delivery plus the local Terms/Privacy versions and URLs. The local-only Terms/Privacy placeholders at `/legal/terms` and `/legal/privacy` are explicitly nonbinding. Production signup and protected actions fail closed without approved published document URLs and versions. Production credential signup and reset also require approved Resend configuration. Keep `.env` private.
2. Start the database with `docker compose up -d db`, then install packages with `npm install`.
3. Run `npm run roles:provision-local` to create/update the application, worker, Stripe webhook, Resend webhook, and reserved MFA proof roles on an existing local volume.
4. Apply the schema with `npm run db:migrate`.
5. Run `npm run db:check-rls:local` to check tenant filtering and direct-write restrictions under `gphkm_runtime`; it rolls back its synthetic fixtures.
6. Create the two local-only test identities once with `NODE_ENV=development npm run auth:bootstrap:local`. The Super Admin email must use a reserved `.test` domain. The customer email must use a separate `.test` address or the exact local-only fixture `client@guestpost.local`.
7. Start the app with `npm run dev`. Local development exposes email/password sign-in for the bootstrap fixtures. Customer email signup, verification, and reset stay off unless `GPHKM_LOCAL_CUSTOMER_EMAIL_SIGNUP_ENABLED=true` and approved email delivery plus legal-document versions/URLs are configured; the local auth smoke command exercises these flows with captured test mail. The customer sign-in origin is `http://localhost:3000`; staff sign-in and pages stay on `http://staff.localhost:3000`. Sign in using the fixture values kept in the private `.env` file.
8. With the app running, optionally run `npm run db:check-session-guard:local`. It signs in the local customer fixture, verifies the customer sign-in page redirects authenticated customers into their workspace, confirms a forwarded customer cookie cannot reveal the customer identity on the staff sign-in page, verifies customer access and staff page/API denial, ages only that temporary session, verifies that all direct Better Auth revocation endpoints reject it, then deletes the temporary session. The check is development-only and refuses non-loopback hosts.
The database is exposed only on `127.0.0.1:54329`. `DATABASE_URL` uses the non-superuser request runtime role; `MIGRATION_DATABASE_URL` uses the separate local migration role. Stripe and Resend webhooks use separate, narrowly granted database roles; none inherits the request runtime role. Provision local role credentials after Docker PostgreSQL is ready and before applying migrations. The PostgreSQL volume persists across restarts. To intentionally reset this development database and its one-time test identities, use `docker compose down -v`.
