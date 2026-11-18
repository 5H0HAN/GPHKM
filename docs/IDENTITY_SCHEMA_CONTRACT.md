# Identity schema and RLS integration contract

This contract documents the identity and tenant-context rules implemented across `src/db/identity-schema.ts` and the migrations. Better Auth core identity tables are a deliberate global-data exception: login and OAuth resolve an identity before a verified user context exists. They are accessible only through server-side Better Auth/domain code, never serialized as unrestricted database records to a client. Tenant and business records remain RLS-scoped under the restricted runtime role.

## Organization creator

Add `organization.created_by text NOT NULL REFERENCES auth_user(id)` and a unique index on `created_by`. Before adding `NOT NULL` to an existing local database, backfill from its `OWNER` membership. This enforces one initial organization per verified user while allowing that user to join other organizations by invitation.

## Invitation

`organization_invitation` stores organization ID, normalized email, fixed `MEMBER` role, SHA-256 token hash, pending/accepted/revoked/expired status, inviter, accepter, creation/expiry/acceptance/revocation timestamps. A partial unique index on `(organization_id, lower(email)) WHERE status = 'PENDING'` prevents duplicate outstanding invitations. Expiry is seven days. Never persist the raw token; deliver it only after the create transaction commits.

Invitation RLS permits a signed-in server transaction to read one invitation only when its token hash equals transaction-local `app.invitation_token_hash`. An accepted invitation inserts or reactivates the verified matching user's active `MEMBER` row and changes invite status in the same transaction. Owner invite/revoke operations run with a previously verified `app.organization_id`. Staff invitations can grant only Admin or Finance; acceptance creates an inactive account, and a different active Super Admin activates it after email verification. Customer and staff invite acceptance use no-store fragment links and explicit POST. Tokens are hashed for acceptance and separately AES-256-GCM encrypted in `invitation_email_outbox`; the runtime role cannot read cipher columns or claim delivery. The restricted worker uses the existing gated Resend boundary. Revocation, acceptance, and expiry cancel pending sends; unknown send outcomes are not retried automatically. Do not display or log raw invite tokens.

Staff invitations are separate: the service layer allows a Super Admin to invite only `ADMIN` or `FINANCE` by normalized email. The initial Super Admin uses controlled bootstrap. A different active Super Admin may promote an active Admin with verified email and TOTP through an audited command. Staff invitations expire after seven days. Signup requires the staff invitation header to match the pending token hash and normalized email, and signup verifies the invited email. Accepting the invitation creates an inactive Admin or Finance account; a Super Admin activates it after verifying the email and TOTP, and activation revokes all existing sessions. Invitation activation cannot grant Super Admin authority; a different active Super Admin may reactivate a previously provisioned inactive Super Admin after the same email and TOTP checks. Staff login uses email/password plus TOTP or a one-time backup code. A different active Super Admin can reset another staff member’s factor and sessions. The Super Admin staff account review, role change, activation, promotion, factor reset, and deactivation UI is available. Customer and staff invitation creation and acceptance flows are implemented; automatic delivery remains disabled until the Resend account, sender domain, webhook, encryption key, and data-handling checks pass. Unknown delivery outcomes require reconciliation and are not automatically retried.

## Staff MFA

Production staff sign-in requires email/password plus TOTP or a one-time backup code. After successful verification, the auth route records proof for the exact Better Auth session using `MFA_PROOF_DATABASE_URL` with the restricted `gphkm_mfa_proof` role. This URL is required when staff MFA is active and must not reuse `DATABASE_URL`. The server guard checks active staff authority, the verified factor, and the matching `staff_mfa_session(session_id,user_id)` row on every protected request. Trusted devices, email/SMS OTP, and staff factor disable are unavailable. Local password-only access requires `NODE_ENV=development`, `GPHKM_LOCAL_AUTH_ENABLED=true`, and `GPHKM_LOCAL_MFA_DISABLED=true`; the bypass does not change database activation or promotion rules. Migration 0197 restores factor requirements and invalidates sessions created during the temporary password-only period.

Customer TOTP uses Better Auth's password challenge and a default-deny allowlist for session creation rather than a separate proof table. While the flag is enabled, only email sign-in, TOTP or backup-code verification, password change, and TOTP disable may create customer sessions.

The auth catch-all accepts only exact configured hosts from `CUSTOMER_APP_URL` and `STAFF_APP_URL`. Better Auth uses distinct cookie names, host-only cookies, and exact trusted origins. Surface guards use the direct `Host` header. Local development uses `localhost:3000` for customers and `staff.localhost:3000` for staff. Register the Google OAuth callback on the customer origin only. Reserve `GPHKM_PUBLIC_BASE_URL` for provider webhooks and readiness; it is never used for auth redirects or cookies. `APP_URL`, `STAFF_URL`, `CUSTOMER_URL`, and `BETTER_AUTH_URL` fail closed.

## Tenant context contract

Every customer organization transaction sets `app.user_id` transaction-locally. Membership reads allow that actor to see their own memberships. The application checks an active membership before setting `app.organization_id`; only then may the transaction read or write tenant rows. All statements in the unit of work use the same transaction connection. Never set a tenant context from an unverified session or pass caller-supplied context directly to SQL.

Organization creation is the only exception before membership exists: set `app.user_id`, insert an organization whose `created_by` equals that user, insert that same user as active `OWNER`, and create its wallet plus audit event atomically. Use a unique `created_by` index to close concurrent first-organization races. The RLS insert policy must check `created_by = app.user_id`; subsequent membership-based access starts only after the owner row exists.

Customer onboarding is available only to a verified customer host session and is idempotent under concurrent requests. The route checks exact `Origin`, caps the request body, and renders no customer workspace content before the first organization exists. Versioned Terms/Privacy consent persistence is implemented in migration `0013_customer_legal_consent.sql` and enforced before onboarding/protected actions. Public signup remains blocked until approved legal copy, document URLs, and immutable version identifiers are configured.

## Appearance preference

`user_appearance_preference` stores one `DARK` or `LIGHT` choice per authenticated user. Migration `0071` enables RLS and grants the normal runtime only self-row `SELECT`, `INSERT`, and `UPDATE`; delete is revoked. Customer saves require a verified customer session. Staff saves require an active staff session. This setting is presentation-only and does not grant access or alter organization settings. Migration `0072` allows pending staff to record proof for activation; proof alone grants no staff workspace access.

## Better Auth core-table boundary

`auth_user`, `auth_account`, `auth_session`, `auth_verification`, and `auth_two_factor` are global Better Auth records and are not tenant-RLS tables. Better Auth needs email/account lookups before authentication and session lookup before `app.user_id` can be trusted. Keep these queries behind server-side Better Auth and identity modules, use parameterized ORM operations, apply the configured host/trusted-origin and session checks, and never return raw account/session/verification records from application routes. `auth_rate_limit` and `auth_staff_rate_limit` are also global operational counters; their separate tables prevent one surface from exhausting the other's bucket. For password reset, Better Auth's `reset-password:` verification identifier is stored as SHA-256 of `gphkm:${surface}:reset-password:${token}`; the surface is therefore cryptographically included in the identifier. The verification value references the target user by ID. Reset validates that scope, expiry, and the current identity domain, then consumes the token and revokes sessions. Staff password reset consumes a token scoped to the issuing surface and revokes existing sessions. The controlled Super Admin break-glass command can also clear legacy factors, proofs, and pending challenges.

## Security tests required at integration

- User sees own membership list, not another user's rows.
- Wrong tenant context returns no rows and rejects writes under the restricted runtime role.
- Unverified user cannot create an organization or accept an invitation.
- Invitation cannot be accepted by a different verified email, after expiry, or after revoke; token hash is single-use.
- Concurrent first-organization attempts create exactly one organization.
- Inactive or unprovisioned staff, sessions without a verified factor, and sessions without exact-session proof are denied.
- Customer TOTP prevents session creation through Google OAuth.
- Reset tokens are accepted only on their issuing surface, and reset revokes sessions. Super Admin recovery operations revoke affected credentials or access and record append-only audit evidence.
