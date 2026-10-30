# ADR-0018: Customer email/password authentication and reset

- Status: Accepted
- Date: 2026-10-30
- Decision owners: Project owner and implementation team

## Context

The product owner approved production customer email/password sign-in, email reset, and password changes alongside Google login. Customer and staff surfaces use separate hosts. Customer access requires verified identity and current legal acceptance; staff provisioning and MFA have separate controls.

## Decision

- Customer email/password is supported in deployed environments. Staff email/password remains invitation-only, with no public signup or password-reset route.
- Customer credential signup is disabled in development and remains disabled in deployed environments until Resend credentials, sender address, and the project data-handling approval gate are configured. Credential accounts must verify email before sign-in.
- After email verification, first organization setup requires acceptance of current Terms and Privacy versions before workspace access; that acceptance is persisted through the existing onboarding flow.
- Password reset uses Better Auth's short-lived token flow and the approved transactional email sender. Put reset tokens in the URL fragment and remove the fragment after a successful reset so the token is not sent in the HTTP request. Reset requests return a generic confirmation and do not reveal account existence. Successful reset revokes all active sessions. Reset tokens and email bodies are not logged.
- A signed-in customer may change a credential password after providing the current password; other active sessions are revoked. Google-only customers continue to use Google account recovery.
- Staff cannot use customer recovery routes on the staff host. Staff account provisioning, role assignment, active status, and MFA remain governed by existing staff controls.

## Consequences

- Production customer credential sign-in and reset need approved Resend configuration. Public credential signup is not enabled until delivery configuration is available.
- Local `.test` fixture authentication continues to work without outbound email; local fixture signup remains disabled.
- Terms/Privacy acceptance remains a required organization-onboarding step after verified signup; no customer workspace access is granted before that acceptance.
- Provider delivery failures are handled without returning account-specific information. Operations must monitor sanitized auth-email failure events and keep email delivery credentials in the deployment secret store.

## Related documents

- [Product specification](../PRODUCT_SPEC.md)
- [Security baseline](../SECURITY_BASELINE.md)
- [Local authentication test fixtures](ADR-0011-local-auth-test-fixtures.md)
- [Open decisions](../OPEN_DECISIONS.md)
