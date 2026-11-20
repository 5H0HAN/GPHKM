# ADR-0039 · Production VM and database backup tiers

- **Status:** Accepted
- **Date:** 2026-11-20
- **Decision owners:** Product / Engineering

## Context

The demo runs one Next.js application and PostgreSQL 17 in a Coolify Compose deployment on a single VM. The team wants a small, manageable production setup and database recovery material in two failure domains.

## Options considered

- Use the Coolify VM for both the application and PostgreSQL, with local and off-host backups.
- Keep the application on Coolify and use a separately managed PostgreSQL service.
- Put application and PostgreSQL on separate self-managed hosts.

## Decision

Use the planned Coolify VM for the production application and PostgreSQL. Maintain local database backups on the VM with a finite retention period, and copy every database backup to a separate private S3-compatible R2/S3 destination with no automatic expiry. Exact VM sizing, local schedule/retention, provider, bucket, and credentials remain launch-time values.

The staging environment mirrors the local-backup part. See the [staging runbook](../STAGING.md) for its current schedule and first-run status. Staging has no off-host backup destination; its data is not protected from VM loss.

## Consequences

- One VM keeps operations small but makes production database availability depend on that host. Backups provide recovery, not high availability.
- The on-host backup is useful for recent mistakes or volume damage but shares the host failure domain. The separate bucket is the recovery copy for VM loss.
- No-expiry full database backups grow over time and retain personal and financial information even after application-level deletion. Legal/Finance must approve the retention and deletion treatment under L-09 before production backups containing live data are retained. Bucket infrastructure can be provisioned earlier. Restores must reapply deletion decisions recorded after the backup before restored data is used.
- Encrypt backups, restrict the bucket and restore credentials, monitor backup age and failures, and rehearse restoring both the database and its matching `BETTER_AUTH_SECRET` before production.
- A successful isolated restore and an approved RPO/RTO remain production gates. This decision does not enable real-money checkout or production signup.

## Revisit trigger

Revisit the database placement if measured load, recovery requirements, or operational incidents justify separating PostgreSQL from the Coolify host or using a managed database.
