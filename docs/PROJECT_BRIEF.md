# Project Brief

## 1. Summary

GPHKM is a customer-and-admin guest-post placement reseller. Organizations browse a curated catalog, fund a shared wallet, place one or more listings in a checkout, and track each item through publication. Staff manage listings, suppliers, inventory imports, customer updates, and fulfillment.

Commercial source is either platform or supplier. Fulfillment contact is separate. These relationships are internal only; the customer catalog is unified and does not expose supplier identity, sourcing mode, source costs, contacts, or staff notes.

## 2. Product goals

1. Make reviewed placements easy for customer organizations to discover and order.
2. Let staff import, clean, price, publish, and maintain inventory with review and audit.
3. Keep the retail offer and price under GPHKM control.
4. Keep wallet funding, order checkout, and item refunds simple, idempotent, and reconcilable.
5. Track every order item through handoff and verified publication with truthful customer updates.
6. Protect customer data, supplier relationships, wallet funds, payment events, and privileged actions.
7. Show licensed third-party domain metrics and transparent internal supplier performance.
8. Keep the first system small enough for a lean team; no publisher portal or payout automation.

## 3. Success measures

Track catalog completeness, import review time, wallet/order integrity, customer status freshness, verified publication evidence, supplier response and publication time, overdue items, customer support caused by unclear status, and authorization/data-exposure incidents. Set numeric service targets after operational capacity and supplier terms are measured.

## 4. User groups

### Customer organization

Verified signup creates the user's first organization, with the user as Owner. A user may join multiple organizations through verified-email invitations. Owners manage shared funding/settings/members and see organization orders, recharge history, and Support cases. Invitations default to Member and expire after seven days. Multiple Owners are allowed; the last Owner must transfer ownership before leaving. Support-managed closure waits for open orders/disputes to resolve and a zero wallet balance, except for legal requirements. Members place orders, see their own orders, and see wallet balance/sufficiency without recharge history.

### Platform staff

Admin handles routine catalog, supplier inventory, imports, fulfillment, customer updates, Support cases, and assigned item-level supplier handoffs. Finance handles restricted financial and cost actions. Ordinary staff hold one role bundle; public staff signup is disabled. Super Admin can access all areas but cannot bypass ledger, evidence, RLS, or audit controls.

### Supplier

A supplier is an internal contact/inventory record only. Suppliers do not sign in to GPHKM. Staff send only necessary article/brief and publication instructions after customer notice and consent. GPHKM records manual payment status and evidence but does not execute supplier payouts.

## 5. Product principles

- Imported rows are staged and reviewed; they never automatically publish a listing or change its retail price/live status.
- Customer projections contain only approved listing and order data.
- Wallet balance derives from immutable ledger entries; provider redirects never prove payment.
- Access grants are organization-level, separate from wallet balance, and checked server-side.
- Orders are itemized and idempotent; one multi-item checkout either commits all items and the debit or none.
- Publication completion requires a live URL and staff verification.
- Lifetime means the publisher intends to keep a placement live indefinitely; GPHKM does not guarantee continued availability or offer a post-completion replacement/refund if it later disappears.
- Unknown costs are not zero. Gross-profit reporting remains provisional until direct costs are confirmed.
- Staff use explicit, audited commands; no silent substitution, hidden financial adjustment, generic status override, or editable audit history.
- Customer-facing wording is GPHKM-branded and hides supplier identity/sourcing while disclosing that approved content may be shared with a publication site/partner to fulfill the order.

## 6. Approved assumptions

- GPHKM starts in a separate project; GuestPost.cc is read-only.
- One Next.js codebase and PostgreSQL, with customer and staff/Admin entry points and login pages on separate subdomains. Use Better Auth with Google sign-in, host-only sessions, and exact origin allowlists; the hostname split is not an authorization boundary. Deployment split remains undecided.
- Stripe is the first USD wallet-funding provider; other providers are later additions.
- Organizations receive 15-day browsing trial; a qualifying settled $50-or-more top-up grants six calendar months of browsing and hidden-URL access.
- Customer article is default; optional paid writing is configurable per listing.
- CSV/XLSX and public/readable Google Sheets are supported through staff-reviewed staging.
- Customer order and Support input is text-only; manual supplier evidence may be an optional private `.eml` or PDF.
- Finance/Super Admin supplier transfer records require a private PDF/EML receipt and transaction reference; downloads are audited, and the receipt does not independently prove bank settlement.
- English and responsive WCAG 2.2 AA are v1 goals; GPHKM remains an internal project name.

## 7. Non-goals for v1

Supplier registration/portal, automated payouts, multi-currency wallets, direct provider order payment, subscriptions, arbitrary website fetching, automated publication monitoring, post-completion link replacement, public catalog before verified sign-in, weighted supplier score, and general ledger.
