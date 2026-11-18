# ADR-0036: Staff password authentication, mandatory TOTP, and Super Admin recovery

- **Status:** Accepted
- **Date:** 2026-11-17
- **Decision owner:** Project owner

> Supersedes the deferred staff-MFA portions of ADR-0007, ADR-0011, and ADR-0015. It does not replace their remaining identity-lifecycle, fixture, or provider-role decisions.

## Context

Migrations 0194–0196 temporarily changed staff sign-in to email/password only and removed the earlier MFA session-proof flow. The project owner clarified that this was not the intended production policy: staff must use email/password plus TOTP, with exact-session proof on protected requests. Migration 0197 restores that requirement and revokes sessions created during the password-only interval.

## Decision

- **Staff sign-in.** Staff use invitation-bound email/password on the staff origin and never use Google. In production, Better Auth requires a verified TOTP code or one-time backup code after the password. Trusted devices, email/SMS OTP, and staff TOTP disable are unavailable.
- **Session proof.** After Better Auth confirms TOTP or a backup code, the auth route resolves the resulting Better Auth session and writes proof for that exact session through the restricted `gphkm_mfa_proof` database role. A protected staff request requires an active staff account, a verified enrolled factor, and a matching `staff_mfa_session(session_id,user_id)` row. A failed proof write returns no session cookie.
- **Enrollment and recovery.** Staff enroll TOTP after invitation acceptance and before activation. Super Admin activation and Admin promotion require a verified email and verified TOTP in PostgreSQL. A different active Super Admin may reset another staff member's authenticator, including when that member has not completed enrollment; reset removes the factor and every session and writes an audit event. The migration-role break-glass command can reset the Super Admin password and factor only when no other active, verified, password-capable Super Admin can recover access.
- **Authority changes.** A different active Super Admin may promote an active Admin with verified email and TOTP through an additive, audited command. Invitations cannot grant Super Admin. No one may self-activate, self-promote, self-reset, or self-deactivate; the last active Super Admin cannot be deactivated. Staff and Support cannot reset customer TOTP.
- **Local testing.** Password-only staff access is allowed only when `NODE_ENV=development`, `GPHKM_LOCAL_AUTH_ENABLED=true`, and `GPHKM_LOCAL_MFA_DISABLED=true`. The flag is rejected outside that configuration, and the auth proof guard rechecks it even for cached instances. Local bypass does not weaken database activation or promotion checks. The `auth:seed-local-staff-mfa` fixture can mark a verified synthetic `.test` account as factor-enrolled; it requires `--show-secret` and an interactive terminal before changing the database, then prints the reusable provisioning URI. Keep that local output private. Real TOTP and session-proof checks use `db:check-staff-mfa:local` with bypass explicitly off and a dedicated `gphkm_staff_mfa_check` database.
- **Migration history and names.** Keep migration 0195 as `staff_auth_recovery`, 0196 as `staff_password_only_authority`, and 0197 as `require_staff_totp`. They record separate, ordered transitions: 0195 adds recovery support, 0196 temporarily allows password-only staff authority, and 0197 restores the accepted TOTP and exact-session proof rules. These migrations are applied locally, so do not rename, renumber, or rewrite 0194–0196; corrective behavior belongs in a later migration.
- **Password reset.** Staff reset links are scoped to the staff origin. Reset revokes all existing sessions. Staff must use the usual TOTP challenge on the next sign-in.
- **Secrets and origins.** `MFA_PROOF_DATABASE_URL` must use the restricted `gphkm_mfa_proof` role whenever staff MFA is enabled. `CUSTOMER_APP_URL` and `STAFF_APP_URL` are distinct browser origins; `GPHKM_PUBLIC_BASE_URL` is only provider-webhook/readiness ingress. Keep `BETTER_AUTH_SECRET` stable and backed up with recovery material; rotating it invalidates existing TOTP secrets and backup codes.

## Consequences

- Production staff access is protected by password, TOTP, and a database record bound to one exact session.
- Backup codes are one-time recovery; trusted-device bypass is unavailable. The staff proof database role is active, and customer TOTP has no staff or Support reset path.
- Pending staff may enroll but cannot use the staff workspace before a Super Admin activates them.
- Local password-only testing is explicit and isolated from production configuration. Database lifecycle rules retain the production factor requirement in every environment.
- The first Super Admin must enroll TOTP before using protected staff functions. Break-glass recovery remains a migration-role operation, never a web route.
- Recovery cannot be guaranteed if the database, application, infrastructure, `BETTER_AUTH_SECRET`, and every recovery channel are all lost.

## Related documents

- [Security baseline](../SECURITY_BASELINE.md)
- [Identity schema contract](../IDENTITY_SCHEMA_CONTRACT.md)
- [Implementation guide](../IMPLEMENTATION_GUIDE.md)
- [Operations and quality](../OPERATIONS_AND_QUALITY.md)
- [Open decisions](../OPEN_DECISIONS.md)
- [ADR-0020: Evidence resolution for ambiguous Stripe Checkout Session creation](ADR-0020-evidence-resolution-of-ambiguous-stripe-session.md)
- [ADR-0021: Require versioned acceptable-content acceptance at checkout](ADR-0021-versioned-acceptable-content-acceptance.md)
- [ADR-0022: Require fresh authentication for customer session revocation](ADR-0022-fresh-customer-session-revocation.md)
- [ADR-0023: Bind Stripe webhook events to the configured API account](ADR-0023-bind-stripe-events-to-configured-account.md)
- [ADR-0024: Final writing decline returns the undelivered stage to wallet](ADR-0024-final-writing-decline.md)
- [ADR-0025: Audited discard of unapplied import batches](ADR-0025-audited-discard-of-unapplied-import-batches.md)
- [ADR-0026: Explicit supplier import mapping and application](ADR-0026-explicit-supplier-import-mapping-and-application.md)
- [ADR-0027: Staff customer directory and access management](ADR-0027-staff-customer-directory-and-access-management.md)
- [ADR-0028: Private object storage and durable cleanup](ADR-0028-private-object-storage-and-durable-cleanup.md)
- [ADR-0029: Order-scoped active Support conversations and standalone cases](ADR-0029-order-scoped-support-conversations.md)
- [ADR-0030: Super Admin self-assignment of fulfillment work](ADR-0030-superadmin-self-assignment.md)
- [ADR-0031: Audited Super Admin same-supplier recovery](ADR-0031-superadmin-same-supplier-recovery.md)
- [ADR-0032: Supplier delivery confirmation gates placement progress](ADR-0032-supplier-delivery-confirmation-gate.md)
- [ADR-0033: Keep checkout recipient consent in a private immutable snapshot](ADR-0033-immutable-supplier-recipient-consent.md)
- [ADR-0034: Allow an audited manual fallback while provider delivery is pending](ADR-0034-audited-manual-fallback-for-pending-supplier-email.md)
- [ADR-0035: Advance placement after a recorded manual supplier send](ADR-0035-advance-after-recorded-manual-send.md)
