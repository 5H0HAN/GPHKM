# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Customer organization Owners** discover placements, manage their organization's members and wallet, place orders, and follow fulfillment.
- **Customer Members** browse, order from the shared wallet, and follow their own orders.
- **Admin staff** curate inventory, manage suppliers privately, review content, and handle assigned fulfillment and support work.
- **Finance staff** reconcile customer funding and record supplier costs and manual transfers.
- **Super Admins** oversee all staff and platform operations while remaining subject to ledger, evidence, RLS, and audit controls.

## Product Purpose

GPHKM helps customer organizations discover and order guest-post placements, fund orders through a shared wallet, and follow each placement through publication. Staff maintain the catalog and coordinate fulfillment. Success means customers can place and understand the progress of orders while staff can manage inventory, money, and evidence accurately and securely.

## Positioning

GPHKM presents one curated, GPHKM-managed marketplace to customers while staff privately handle supplier relationships, inventory review, pricing, and publication coordination. Each selected listing becomes a separately tracked placement, including when several placements are ordered together.

## Operating Context

Customers use a web workspace after verified sign-in. New organizations receive a 15-day browsing period. A settled qualifying wallet top-up unlocks continued browsing and eligible listing URLs for the policy-defined term. Customers select up to 25 listings per checkout, provide text-only order details, fund orders from the organization wallet, and follow GPHKM-branded milestones and updates.

Staff use a separate web surface to maintain suppliers and listings, stage and review CSV/XLSX or public Google Sheets inventory, set customer prices and availability, manage assigned fulfillment, contact publication partners, and reconcile financial events. Suppliers do not sign in to GPHKM.

## Capabilities and Constraints

- The customer catalog does not disclose supplier identity, commercial source, source cost, or internal staff notes. Listing URLs are hidden unless the customer has marketplace access or a listing is explicitly public; browsing access is still required.
- The v1 wallet is organization-scoped and USD-denominated. Stripe funds the wallet; orders spend wallet balance. The initial qualifying top-up is $50, and the default access grant is six calendar months. The audited policy may set future grants to six months, one year, or unrestricted access.
- Orders are itemized. Customer-provided articles are the default; eligible listings may offer GPHKM Writing. Customer order details and support requests are text-only.
- Staff review imported inventory before applying it. Imports do not automatically publish listings or change customer prices or live status.
- Open PageRank is the first domain-metric integration. Ahrefs and Moz remain future integrations. Customer display of third-party metrics requires rights, attribution, redistribution, and cost review.
- Authentication and authorization are enforced server-side and reinforced with PostgreSQL row-level security, isolated customer and staff sessions, explicit permissions, idempotent money operations, and append-only audit records.
- The public product surface is separate from the customer and staff workspaces. Customer and staff entry points use separate, configurable subdomains.
- PayPal and other funding providers, supplier accounts, supplier payout execution, multi-currency wallets, and a customer supplier portal are outside v1 scope.
- Real-money production remains gated on the documented U.S. entity, provider-account, and qualified legal/finance reviews. Hosting, production database details, and deployment topology remain open until their documented validation gates are satisfied.

## Brand Commitments

GPHKM is the current internal project name; a final public brand name is undecided. English is the v1 language.

## Evidence on Hand

The repository contains the approved product and security specifications, a working local application, and synthetic local demo data. No verified customer testimonials, case studies, publication outcomes, or performance benchmarks have been approved; do not invent or imply them.

## Product Principles

- Keep the customer marketplace unified and make supplier relationships private.
- Review and approve imported inventory before it changes the live catalog.
- Preserve exact, auditable financial and fulfillment history instead of silently rewriting outcomes.
- Give customers accurate, GPHKM-branded order progress without exposing internal sourcing details or promising SEO results.
- Keep the system small enough for a lean team to operate while enforcing server-side authorization and tenant boundaries.

## Accessibility & Inclusion

Customer and staff web surfaces target responsive WCAG 2.2 AA accessibility. Support keyboard access, visible focus, readable contrast, and usable layouts on mobile and desktop.
