# Proposed Repository Structure

This is a planning outline, not a request to create these files now. Create only what the approved slices need.

    GPHKM/
    ├── README.md
    ├── AGENTS.md
    ├── docs/
    │   ├── PROJECT_BRIEF.md
    │   ├── SCOPE.md
    │   ├── PRODUCT_SPEC.md
    │   ├── SUPPLIER_HANDOFF.md
    │   ├── MONEY_FLOW_ARCHITECTURE.md
    │   ├── SECURITY_BASELINE.md
    │   ├── RBAC_MATRIX.md
    │   ├── DOMAIN_MODEL.md
    │   ├── THREAT_MODEL.md
    │   ├── ARCHITECTURE_PROPOSAL.md
    │   ├── PROJECT_STRUCTURE.md
    │   ├── OPERATIONS_AND_QUALITY.md
    │   ├── IMPLEMENTATION_GUIDE.md
    │   ├── OPEN_DECISIONS.md
    │   └── adr/
    ├── src/
    │   ├── app/                 # Customer and staff routes in one Next.js app
    │   ├── modules/             # Server-only domain modules
    │   ├── auth/                # Better Auth and GPHKM authority checks
    │   ├── db/                  # Schema/migrations after Slice 0
    │   └── shared/              # Add only genuinely shared helpers
    ├── worker/                  # Add one DB-backed worker only when needed
    └── infrastructure/          # Add after hosting is selected

## Structure rules

- One Next.js application, one PostgreSQL database, and one authoritative server layer.
- Customer and staff routes share the application but use separate layouts, authority checks, and allowlisted projections.
- Keep business modules in the application. Do not create one package or service per domain.
- Add a worker only when durable background execution is needed; use database-backed jobs/outbox first.
- Keep runtime database identities restricted; migrations use a separate elevated identity.
- Keep secrets out of source and browser bundles. Add deployment files only after Slice 0 selects the hosting model.
- Do not scaffold payment providers, object storage, queues, or shared packages that are not yet needed.
