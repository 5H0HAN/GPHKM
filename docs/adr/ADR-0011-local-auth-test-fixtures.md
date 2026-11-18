# ADR-0011: Local-only authentication test fixtures

- Status: Accepted
- Date: 2026-10-28
- Decision owners: Project owner and implementation team

> **Superseded by [ADR-0036](ADR-0036-staff-authentication-mandatory-totp.md).** Current staff MFA is mandatory outside the explicitly configured local development bypass.

## Context

The project owner requested email/password logins for local testing. Production customer email/password was later approved separately in [ADR-0018](ADR-0018-customer-email-password-auth.md); local test credentials must never become public production signup or default credentials. Staff access requires controlled provisioning. The current staff password and activation policy is [ADR-0036](ADR-0036-staff-authentication-mandatory-totp.md).

## Decision

- Local email/password authentication is enabled only when `NODE_ENV=development` and `GPHKM_LOCAL_AUTH_ENABLED=true`; any other environment rejects that opt-in.
- The ignored `.env` supplies the Better Auth secret, loopback base URL, a Super Admin `.test` email, a separate Customer Owner `.test` email or the exact local fixture `client@guestpost.local`, and separate passwords. That `.local` address is accepted only for local bootstrap, is preverified, and cannot receive verification or reset mail. Source code and `.env.example` contain no usable credentials.
- Staff local fixtures use invitation-bound email/password. Password-only access requires both the local auth flag and the development-only MFA bypass.
- A one-time local CLI bootstrap uses the migration URL only after validating a loopback database and app origin. It hashes passwords with Better Auth and atomically creates one Super Admin plus one separate Customer Owner and organization. It rejects repeats and existing accounts rather than elevating or resetting them.
- Local fixture signup remains disabled. Production customer credential signup follows the separate email-verification and mail-configuration gates in ADR-0018.
- Fixture creation does not bypass customer authorization. Customer actions still require active organization membership and transaction-local tenant context. At that checkpoint, staff authorization required the assigned role, active account, and normal permission checks.

## Consequences

- Local API/UI authentication can be exercised without Google OAuth credentials or a mail service.
- Local fixture passwords are private, randomly generated, and untracked. The setup command is intentionally not a public HTTP endpoint.
- The bootstrap is for local development only. Production must retain verified customer identity, controlled staff invitations and activation, and managed secrets. Staff TOTP required a later approved decision and security review.
- At the interim checkpoint, local testing used the Super Admin fixture without an MFA challenge. RBAC and RLS policies continue to apply.

## Related documents

- [Product specification](../PRODUCT_SPEC.md)
- [Security baseline](../SECURITY_BASELINE.md)
- [RBAC matrix](../RBAC_MATRIX.md)
- [Open decisions](../OPEN_DECISIONS.md)
