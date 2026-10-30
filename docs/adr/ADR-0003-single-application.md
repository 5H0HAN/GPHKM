# ADR-0003: Single application and deferred infrastructure choices

- **Status:** Accepted direction
- **Date:** 2026-10-27
- **Decision owners:** Product / Engineering / Security

## Context

GPHKM needs customer and staff workflows with shared domain rules and a modest initial operating footprint. GuestPost.cc has a larger multi-service shape that is not needed for a clean v1 build.

## Decision

Use one Next.js application/codebase with distinct customer and staff areas, server-only domain modules, PostgreSQL, and Better Auth with Google sign-in. The areas now have separate customer and staff subdomain entry points under [ADR-0012](ADR-0012-customer-staff-subdomains.md); the hostname split does not require separate codebases or services. Add one lightweight worker using database-backed durable jobs/outbox only when retryable or scheduled work requires it. Do not add Redis, multiple worker lanes, a separate API deployment, or microservices initially.

Select ORM, migration tooling, hosting, and deployment in Slice 0 after reviewing RLS, transaction behavior, cost, recoverability, and team familiarity.

## Consequences

- Business rules and authorization remain centralized in one server-side application.
- Customer and staff routes use separate permission checks and explicit data projections.
- A worker can be added without making queue infrastructure a prerequisite for the product.
- The ADR deliberately does not select an ORM, host, or deployment provider.

## Revisit trigger

Revisit if measured workload, reliability, isolation, or team structure demonstrates a concrete need for another deployable component.
