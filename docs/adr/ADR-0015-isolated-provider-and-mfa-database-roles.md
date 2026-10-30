# ADR-0015: Isolate provider and staff MFA database capabilities

- **Status:** Accepted
- **Date:** 2026-10-29
- **Decision owner:** Project owner

## Context

Stripe wallet-crediting events, Resend delivery callbacks, and staff MFA session proof were protected by application request paths, but provider capabilities must not be callable through the general request runtime. A caller-settable PostgreSQL setting cannot prove an HTTP provider signature or a successful MFA challenge. Access grants also use UTC calendar-month terms, which must not depend on a connection's timezone.

## Decision

- The signature-verifying Stripe webhook route uses a dedicated `gphkm_webhook` database identity. It can execute only the narrow Stripe event processing and normalized-fact functions. The general request runtime role cannot execute either function.
- The signature-verifying Resend webhook route uses a separate `gphkm_resend_webhook` identity for both supplier-packet and customer-notification events. It can execute the notification event command and has only the row privileges and RLS scope needed for supplier-packet correlation; it cannot execute Stripe wallet functions. The general request runtime cannot execute the notification event command.
- The Better Auth MFA verification hook uses a separate `gphkm_mfa_proof` identity. It can execute only a function that verifies the active staff user, exact unexpired Better Auth session, enabled MFA flag, and allowed verification method before writing that session's proof. The general runtime retains read-only access to proof rows for staff authorization checks.
- Neither provider role inherits the general runtime role; the Resend role has no direct notification table access, and its supplier-packet table grants are restricted by RLS. Connection URLs and passwords are distinct secret values.
- Pin the Stripe settlement function's `TimeZone` configuration to UTC so six- and twelve-calendar-month grants follow UTC month arithmetic and end-of-month clamping.
- Customer metric queries select the latest observation before filtering its status or redistribution approval. A newer missing, failed, stale, or unapproved row suppresses an older available customer value.

## Consequences

- Local and production environments must provision separate runtime, worker, Stripe webhook, Resend webhook, and MFA-proof credentials before those paths can complete. Missing webhook or MFA-proof configuration fails closed.
- The database function grants are reviewed alongside the server call sites; custom GUCs are context only and never stand in for cryptographic verification.
- These roles are not general worker roles and do not receive table access. The notification worker remains separate.
- Provider secrets remain out of source control and browser bundles.
