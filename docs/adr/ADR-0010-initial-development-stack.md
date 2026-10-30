# ADR-0010: Initial development stack and local database

- Status: Accepted for initial implementation; production connection details remain conditional
- Date: 2026-10-28
- Decision owners: Project owner and implementation team

## Context

Implementation is starting from the approved single-application architecture. The project owner has Docker installed and authorized its use for local development. The preferred candidates were Next.js, PostgreSQL, Better Auth, and Drizzle/Drizzle Kit, while the production app/Neon connection and pooled-connection behavior were still subject to Slice 0 validation.

## Decisions

1. Build one TypeScript Next.js App Router application; keep domain and authorization logic server-side.
2. Use PostgreSQL and Drizzle ORM with Drizzle Kit as the initial schema and migration toolchain. Keep generated SQL migrations reviewable and use migrations rather than schema push for shared environments.
3. Run a clean PostgreSQL 17 instance locally with Docker Compose. Keep the migration/owner credential separate from a restricted application runtime role. Local credentials live in an ignored `.env` file and are never committed.
4. Use direct PostgreSQL connections for local development. Tenant context must be set transaction-locally on the transaction handle for protected queries; a connection pooler is not enabled until its transaction-local context behavior is proven.
5. Keep Coolify + Neon as the preferred production direction, not a production-ready decision. Before selecting production connection pooling, demonstrate RLS isolation and transaction behavior with the exact Neon connection mode, restricted runtime role, Better Auth schema, and retry/concurrency paths. Use a direct migration connection.
6. Use the project’s documented dark-first theme and a persistent per-user Dark/Light setting. The initial default is dark. Keep preference storage isolated from organization-wide settings.

## Consequences

- Local development and schema review can proceed without production provider accounts.
- Local Compose is disposable development infrastructure; it is not a backup or production deployment plan.
- The first database schema and tenant-context helper must be designed together. Tests must run under the restricted runtime identity, not the migration owner.
- The ORM choice is an initial implementation choice. If the Better Auth adapter or RLS proof fails, stop before building domain features and revise this ADR.
- Production Neon pooling, deployment, backup/recovery settings, and real-money provider configuration remain launch gates.

## Validation before closing the production portion of Slice 0

- Apply the same migration path to a fresh local database and a test database.
- Verify Better Auth’s generated schema uses the selected Drizzle adapter without conflicting migrations.
- Verify tenant-scoped reads/writes fail closed across organizations under the restricted runtime role.
- Verify transaction-local tenant settings do not survive commit/rollback or leak across reused connections.
- Verify atomic wallet/order transaction behavior before implementing money features.
- Record Neon region, connection limits, runtime/migration credentials, recovery settings, backup and restore evidence, and deployment choice.

## Related documents

- [Architecture proposal](../ARCHITECTURE_PROPOSAL.md)
- [Implementation guide](../IMPLEMENTATION_GUIDE.md)
- [Security baseline](../SECURITY_BASELINE.md)
- [Open decisions](../OPEN_DECISIONS.md)
