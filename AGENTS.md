# GPHKM Project Instructions

## Project boundary

- GPHKM is a new, clean-build project. GuestPost.cc may be consulted as a read-only reference when the user asks; do not edit it or copy its implementation wholesale.
- Build only what the approved GPHKM scope needs. Prefer one modular application, one relational database, and a small number of deployable components over microservices or speculative abstraction.
- Suppliers are private internal records. Do not create supplier login, publisher portal, payout, or settlement functionality unless the user changes scope.
- `PLATFORM_OWNED` and `SUPPLIER_SOURCED` are internal admin classifications. The customer catalog is unified and customer projections must not disclose either classification or supplier identity.

## Before implementation

- Read `README.md`, `docs/SCOPE.md`, `docs/PRODUCT_SPEC.md`, `docs/MONEY_FLOW_ARCHITECTURE.md`, `docs/SECURITY_BASELINE.md`, `docs/RBAC_MATRIX.md`, and `docs/IMPLEMENTATION_GUIDE.md`.
- Resolve the implementation-blocking decisions identified in `docs/OPEN_DECISIONS.md`. Do not silently promote recommendations into approved policy.
- Keep docs as the canonical source for product behavior, money invariants, permissions, and security boundaries. Update the relevant doc and ADR when a material decision changes.

## Security and financial rules

- Authorization is enforced by the server and database, not UI route visibility.
- Resolve active organization membership and staff permissions at every sensitive command.
- Use least privilege, deny by default, and keep customer and staff authority separate.
- Use restricted database runtime identities and tenant isolation; test as the real runtime role.
- Customer API responses use explicit allowlists and never serialize internal supplier/source data.
- Wallet changes use exact amounts, immutable ledger entries, scoped idempotency, atomic transactions, and reconciliation. Never mutate a balance directly.
- Provider events are verified and deduplicated; redirects do not prove payment. Treat post-send timeouts as ambiguous until reconciled.
- Do not add external calls inside retryable database transactions.
- Treat imports, attachments, URLs, provider payloads, and queued jobs as untrusted input.
- Never commit secrets or real customer/payment/supplier data.

## Working style

- Make the smallest change that satisfies an approved requirement.
- For public, customer, or staff UI changes, follow `docs/FRONTEND_UX_WORKFLOW.md` and the current `DESIGN.md`; review the rendered page at desktop and mobile sizes before calling the work done.
- Do not add dependencies, services, feature frameworks, or generalized abstractions without a current need.
- Add tests for changed behavior and security boundaries when implementation is authorized.
- Keep migrations, RBAC changes, money paths, and import/export handling reviewable and documented.
