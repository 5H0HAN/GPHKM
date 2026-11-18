# ADR-0018: Customer email/password authentication and reset

- Status: Accepted
- Date: 2026-10-30
- Decision owners: Project owner and implementation team

> The interim staff MFA and password-reset portions described here are superseded by [ADR-0036](ADR-0036-staff-authentication-mandatory-totp.md). The customer email/password, password setup, customer TOTP, and customer recovery decision remains current.

## Context

The product owner approved production customer email/password sign-in, email reset, and password changes alongside Google login. Customer and staff surfaces use separate hosts. For local development, the customer app uses `http://localhost:3000` and staff uses `http://staff.localhost:3000`; host-only cookies keep sessions separate. Customer access requires verified identity and current legal acceptance; staff provisioning uses invitation-bound email/password and verified email. Migrations 0194–0196 temporarily postponed staff TOTP; [ADR-0036](ADR-0036-staff-authentication-mandatory-totp.md) restores the accepted production staff MFA policy.

## Decision

- Customer email/password is supported in deployed environments. At that checkpoint, staff email/password was invitation-only without a public signup or password-reset route.
- Customer credential signup is disabled in development and remains disabled in deployed environments until Resend credentials, sender address, and the project data-handling approval gate are configured. Credential accounts must verify email before sign-in.
- Before customer email/password account creation, require explicit acceptance of current Terms and Privacy versions and record versioned acceptance evidence for the created user. Email verification remains required before sign-in. Initial organization setup reuses that acceptance unless either document version or URL has changed.
- Password reset uses Better Auth's short-lived token flow and the approved transactional email sender. Put reset tokens in the URL fragment and remove the fragment after a successful reset so the token is not sent in the HTTP request. Reset requests return a generic confirmation and do not reveal account existence. Successful reset revokes all active sessions. Reset tokens and email bodies are not logged.
- A signed-in customer may change a credential password after providing the current password; other active sessions are revoked. Google-only customers continue to use Google account recovery.
- A Google-only customer may add a password in Settings before enrolling optional TOTP. While customer TOTP is enabled, sign-in requires email/password plus TOTP or a backup code; backup codes are the only self-service factor recovery, and staff cannot reset a customer's factor.
- Staff cannot use customer recovery routes on the staff host. Staff account provisioning, role assignment, active status, staff password reset, and mandatory MFA remain governed by [ADR-0036](ADR-0036-staff-authentication-mandatory-totp.md).

## Consequences

- Production customer credential sign-in and reset need approved Resend configuration. Public credential signup is not enabled until delivery configuration is available.
- Local `.test` fixture authentication continues to work without outbound email; local fixture signup remains disabled.
- A current signup acceptance is reused at first organization setup. Existing accounts and changed Terms/Privacy versions are prompted during onboarding before protected access.
- Provider delivery failures are handled without returning account-specific information. Operations must monitor sanitized auth-email failure events and keep email delivery credentials in the deployment secret store.

## Related documents

- [Product specification](../PRODUCT_SPEC.md)
- [Security baseline](../SECURITY_BASELINE.md)
- [Local authentication test fixtures](ADR-0011-local-auth-test-fixtures.md)
- [Open decisions](../OPEN_DECISIONS.md)
