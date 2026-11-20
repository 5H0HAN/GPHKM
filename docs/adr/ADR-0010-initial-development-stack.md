# ADR-0010: Initial development stack and local database

- Status: Accepted for initial implementation; production connection details remain conditional
- Date: 2026-10-28
- Decision owners: Project owner and implementation team

## Supersession note (2026-11-20)

This ADR remains the accepted record for the initial application, ORM, and local PostgreSQL stack. Its Neon assessment and provisional production connection guidance below are historical, not the active hosting direction. [ADR-0039](ADR-0039-production-vm-database-backups.md) supersedes decision 5 and records the owner's production Coolify VM/PostgreSQL and two-tier backup direction. Keep the validation evidence below as history; target-VM checks and recovery proof remain open under O-01.

## Context

Implementation is starting from the approved single-application architecture. The project owner has Docker installed and authorized its use for local development. The preferred candidates were Next.js, PostgreSQL, Better Auth, and Drizzle/Drizzle Kit, while the production app/Neon connection and pooled-connection behavior were still subject to Slice 0 validation.

## Decisions

1. Build one TypeScript Next.js App Router application; keep domain and authorization logic server-side.
2. Use PostgreSQL and Drizzle ORM with Drizzle Kit as the initial schema and migration toolchain. Keep generated SQL migrations reviewable and use migrations rather than schema push for shared environments.
3. Run a clean PostgreSQL 17 instance locally with Docker Compose. Keep the migration/owner credential separate from a restricted application runtime role. Local credentials live in an ignored `.env` file and are never committed.
4. Use direct PostgreSQL connections for local development. Tenant context must be set transaction-locally on the transaction handle for protected queries; a connection pooler is not enabled until its transaction-local context behavior is proven.
5. (Superseded 2026-11-20 by ADR-0039.) The initial provisional direction was Coolify + Neon, not a production-ready decision. The historical checks and assessment below describe why it was considered; the current production direction is recorded in ADR-0039.
6. Use the project’s documented dark-first theme and a persistent per-user Dark/Light setting. The initial default is dark. Keep preference storage isolated from organization-wide settings.

## Neon connection assessment (2026-10-29)

The current application sets `app.user_id` and `app.organization_id` with PostgreSQL `set_config(..., true)` on the active Drizzle transaction before protected reads and writes. That is transaction-local context, which is the required shape for a Neon pooled endpoint using PgBouncer transaction mode. The app currently uses `pg.Pool` with a maximum of five connections per process ([database client](../../src/db/index.ts)); size the aggregate across app instances and the separate worker, webhook, and MFA-proof roles.

Conditional deployment recommendation: use Neon's pooled TLS URL for runtime `DATABASE_URL` only after running the restricted-role RLS smoke and transaction/concurrency checks against that exact Neon endpoint. Keep `MIGRATION_DATABASE_URL` direct/unpooled for Drizzle migrations. Do not use session-level `SET`, session advisory locks, temp tables, `LISTEN`, or any other connection-persistent state on the pooled runtime path. Neon documents transaction-mode pooling and recommends a direct connection for session-dependent work in [Connection pooling](https://neon.com/docs/connect/connection-pooling) and [Connecting Neon to your stack](https://neon.com/docs/get-started/connect-neon).

This is a code/provider compatibility assessment, not a production validation. Neon account/region/plan selection, pool capacity, TLS connectivity from the Coolify VPS, Better Auth migration rehearsal, backup configuration, restore drill, and final RLS/race checks against Neon remain open under O-01. Do not close O-01 based on local Docker checks alone.

## Consequences

- Local development and schema review can proceed without production provider accounts.
- Local Compose is disposable development infrastructure; it is not a backup or production deployment plan.
- The first database schema and tenant-context helper must be designed together. Tests must run under the restricted runtime identity, not the migration owner.
- The ORM choice is an initial implementation choice. If the Better Auth adapter or RLS proof fails, stop before building domain features and revise this ADR.
- Production VM sizing, database deployment, backup/recovery settings, and real-money provider configuration remain launch gates under the current decisions in ADR-0039 and O-01.

## Validation before closing the production portion of Slice 0

- Apply the same migration path to a fresh local database and a test database.
- Verify Better Auth’s generated schema uses the selected Drizzle adapter without conflicting migrations.
- Verify tenant-scoped reads/writes fail closed across organizations under the restricted runtime role.
- Verify transaction-local tenant settings do not survive commit/rollback or leak across reused connections.
- Verify atomic wallet/order transaction behavior before implementing money features.
- Record the selected VM region and capacity, connection limits, runtime/migration credentials, recovery settings, backup and restore evidence, and deployment validation.

## Related documents

- [Architecture proposal](../ARCHITECTURE_PROPOSAL.md)
- [Implementation guide](../IMPLEMENTATION_GUIDE.md)
- [Security baseline](../SECURITY_BASELINE.md)
- [Open decisions](../OPEN_DECISIONS.md)
