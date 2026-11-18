# ADR-0015: Isolate provider database capabilities and staff MFA proof

- **Status:** Accepted
- **Date:** 2026-10-29
- **Decision owner:** Project owner

> **Superseded by [ADR-0036](ADR-0036-staff-authentication-mandatory-totp.md).** The restricted staff proof role is active again; the provider role boundaries below still apply.

## Context

Stripe wallet-crediting events, Resend delivery callbacks, and the then-planned staff MFA session proof were protected by application request paths, but provider capabilities must not be callable through the general request runtime. A caller-settable PostgreSQL setting cannot prove an HTTP provider signature. Access grants also use UTC calendar-month terms, which must not depend on a connection's timezone. At the time this decision was accepted, the owner had deferred staff MFA. ADR-0036 supersedes that part of the decision and restores mandatory staff TOTP with exact-session proof.

## Decision

- The signature-verifying Stripe webhook route uses a dedicated `gphkm_webhook` database identity. It can execute only the narrow Stripe event processing and normalized-fact functions. The general request runtime role cannot execute either function.
- The signature-verifying Resend webhook route uses a separate `gphkm_resend_webhook` identity for both supplier-packet and customer-notification events. It can execute the notification event command and has only the row privileges and RLS scope needed for supplier-packet correlation; it cannot execute Stripe wallet functions. The general request runtime cannot execute the notification event command.
- The `gphkm_mfa_proof` identity writes staff MFA proof only through the narrow verified-session function; it does not inherit the application role.
- Neither provider role inherits the general runtime role; the Resend role has no direct notification table access, and its supplier-packet table grants are restricted by RLS. Connection URLs and passwords are distinct secret values.
- Pin the Stripe settlement function's `TimeZone` configuration to UTC so six- and twelve-calendar-month grants follow UTC month arithmetic and end-of-month clamping.
- Customer metric queries select the latest observation before filtering its status or redistribution approval. A newer missing, failed, stale, or unapproved row suppresses an older available customer value.

## Consequences

- The local provisioner retains the separate MFA proof role because historical migrations grant it privileges. The staff auth route uses this role when MFA is required; the explicit local development bypass skips proof checks.
- The database function grants are reviewed alongside the server call sites; custom GUCs are context only and never stand in for cryptographic provider verification.
- These roles are not general worker roles and do not receive table access. The notification worker remains separate.
- Provider secrets remain out of source control and browser bundles.
