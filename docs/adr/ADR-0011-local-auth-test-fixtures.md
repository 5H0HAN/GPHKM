# ADR-0011: Local-only authentication test fixtures

- Status: Accepted
- Date: 2026-10-28
- Decision owners: Project owner and implementation team

## Context

The project owner requested email/password logins for local testing. Production customer email/password was later approved separately in [ADR-0018](ADR-0018-customer-email-password-auth.md); local test credentials must never become public production signup or default credentials. Staff access requires controlled provisioning and MFA.

## Decision

- Local email/password authentication is enabled only when `NODE_ENV=development` and `GPHKM_LOCAL_AUTH_ENABLED=true`; any other environment rejects that opt-in.
- The ignored `.env` supplies the Better Auth secret, loopback base URL, distinct Super Admin and Customer Owner `.test` emails, and separate passwords. Source code and `.env.example` contain no usable credentials.
- For local UI work only, `GPHKM_LOCAL_MFA_DISABLED=true` may skip the staff TOTP challenge and exact-session MFA proof check. It is valid only with `NODE_ENV=development` and `GPHKM_LOCAL_AUTH_ENABLED=true`; the default remains `false`, and auth configuration rejects the bypass elsewhere. Staff must still be an active staff identity and retains normal permission checks. This setting does not alter staff invitation activation requirements or production behavior.
- A one-time local CLI bootstrap uses the migration URL only after validating a loopback database and app origin. It hashes passwords with Better Auth and atomically creates one Super Admin plus one separate Customer Owner and organization. It rejects repeats and existing accounts rather than elevating or resetting them.
- Local fixture signup remains disabled. Production customer credential signup follows the separate email-verification and mail-configuration gates in ADR-0018.
- Fixture creation does not bypass customer authorization. Customer actions still require active organization membership and transaction-local tenant context. Staff authorization always requires the assigned role and active account; exact-session MFA proof is required unless the narrowly gated local UI-testing opt-in is active.

## Consequences

- Local API/UI authentication can be exercised without Google OAuth credentials or a mail service.
- Local fixture passwords are private, randomly generated, and untracked. The setup command is intentionally not a public HTTP endpoint.
- The bootstrap is for local development only. Production must retain verified customer identity, controlled staff invitations, MFA enforcement, and managed secrets.
- Local testing can use the Super Admin fixture without repeated MFA only when the development-only bypass is explicitly enabled; set it to `false` to exercise the MFA flow. RBAC and RLS policies continue to apply in either mode.

## Related documents

- [Product specification](../PRODUCT_SPEC.md)
- [Security baseline](../SECURITY_BASELINE.md)
- [RBAC matrix](../RBAC_MATRIX.md)
- [Open decisions](../OPEN_DECISIONS.md)
