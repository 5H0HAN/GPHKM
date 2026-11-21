# ADR-0039 · Production database hosting and recovery

- **Status:** Accepted
- **Date:** 2026-11-20
- **Decision owners:** Product / Engineering

## Context

The team wants a small, manageable production setup with a tested database recovery process. Exact infrastructure identifiers and recovery configuration are maintained in private operations records.

## Options considered

- Use a self-managed PostgreSQL deployment.
- Use a separately managed PostgreSQL service.
- Separate the application and database infrastructure.

## Decision

Use self-managed PostgreSQL for the initial production direction, subject to private deployment and recovery configuration. Do not store host, provider, location, schedule, retention, credential, or recovery evidence in this public ADR. Before production, complete an isolated restore rehearsal and obtain approval for the applicable data-retention policy.

## Consequences

- Production database availability and recovery depend on the selected deployment and its tested recovery process.
- Legal/Finance must approve retention and deletion handling before production data is retained in recovery copies.
- Restrict recovery access, protect required application secrets, and verify restoration on an isolated target before production.
- Recovery validation remains a production gate. This decision does not enable real-money checkout or production signup.

## Revisit trigger

Revisit the database placement if measured load, recovery requirements, or operational incidents justify separating PostgreSQL from the Coolify host or using a managed database.
