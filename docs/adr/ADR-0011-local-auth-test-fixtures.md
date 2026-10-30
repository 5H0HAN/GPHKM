# ADR-0011: Local-only authentication test fixtures

- Status: Accepted
- Date: 2026-10-28
- Decision owners: Project owner and implementation team

## Context

The project owner requested email/password logins for local testing. The production customer identity direction remains Google sign-in, and staff access requires controlled provisioning and MFA. Local test credentials must never become public production signup or default credentials.

## Decision

- Local email/password authentication is enabled only when `NODE_ENV=development` and `GPHKM_LOCAL_AUTH_ENABLED=true`; any other environment rejects that opt-in.
- The ignored `.env` supplies the Better Auth secret, loopback base URL, distinct Super Admin and Customer Owner `.test` emails, and separate passwords. Source code and `.env.example` contain no usable credentials.
- A one-time local CLI bootstrap uses the migration URL only after validating a loopback database and app origin. It hashes passwords with Better Auth and atomically creates one Super Admin plus one separate Customer Owner and organization. It rejects repeats and existing accounts rather than elevating or resetting them.
- Public credential signup remains disabled. Local fixtures do not change production identity policy.
- Fixture creation grants no special customer or staff session bypass. Customer actions still require active organization membership and transaction-local tenant context; staff actions still require the assigned role, active account, and server-verifiable MFA session proof.

## Consequences

- Local API/UI authentication can be exercised without Google OAuth credentials or a mail service.
- Local fixture passwords are private, randomly generated, and untracked. The setup command is intentionally not a public HTTP endpoint.
- The bootstrap is for local development only. Production must retain Google customer sign-in, controlled staff invitations, MFA enforcement, and managed secrets.
- A local Super Admin fixture can access the implemented staff areas only after completing MFA; customer and staff authorization continue to follow the current RBAC and RLS policies.

## Related documents

- [Product specification](../PRODUCT_SPEC.md)
- [Security baseline](../SECURITY_BASELINE.md)
- [RBAC matrix](../RBAC_MATRIX.md)
- [Open decisions](../OPEN_DECISIONS.md)
