# Identity schema and RLS integration contract

This contract documents the identity and tenant-context rules implemented across `src/db/identity-schema.ts` and the migrations. Better Auth core identity tables are a deliberate global-data exception: login and OAuth resolve an identity before a verified user context exists. They are accessible only through server-side Better Auth/domain code, never serialized as unrestricted database records to a client. Tenant and business records remain RLS-scoped under the restricted runtime role.

## Organization creator

Add `organization.created_by text NOT NULL REFERENCES auth_user(id)` and a unique index on `created_by`. Before adding `NOT NULL` to an existing local database, backfill from its `OWNER` membership. This enforces one initial organization per verified user while allowing that user to join other organizations by invitation.

## Invitation

`organization_invitation` stores organization ID, normalized email, fixed `MEMBER` role, SHA-256 token hash, pending/accepted/revoked/expired status, inviter, accepter, creation/expiry/acceptance/revocation timestamps. A partial unique index on `(organization_id, lower(email)) WHERE status = 'PENDING'` prevents duplicate outstanding invitations. Expiry is seven days. Never persist the raw token; deliver it only after the create transaction commits.

Invitation RLS permits a signed-in server transaction to read one invitation only when its token hash equals transaction-local `app.invitation_token_hash`. An accepted invitation inserts or reactivates the verified matching user's active `MEMBER` row and changes invite status in the same transaction. Owner invite/revoke operations run with a previously verified `app.organization_id`. Staff invitations can grant only Admin or Finance; acceptance creates an inactive account, and Super Admin activation requires verified TOTP. Customer and staff invite acceptance use no-store fragment links and explicit POST. Tokens are hashed for acceptance and separately AES-256-GCM encrypted in `invitation_email_outbox`; the runtime role cannot read cipher columns or claim delivery. The restricted worker uses the existing gated Resend boundary. Revocation, acceptance, and expiry cancel pending sends; unknown send outcomes are not retried automatically. Do not display or log raw invite tokens.

Staff invitations are separate: the service layer allows a Super Admin to invite only `ADMIN` or `FINANCE` by normalized email. Super Admin assignment remains a controlled bootstrap action. Staff invitation tokens are hashed, expire after seven days, and bind acceptance to the same verified email. Accepting the invitation creates a disabled staff account; a Super Admin activates it only after a verified TOTP enrollment, and activation revokes all existing sessions so the next staff session must pass MFA. Pending or deactivated staff may establish a staff-host session to enroll or verify MFA, but no staff command or data access is granted until activation and session proof pass the server guard. MFA-management endpoints also require a staff-account record. The Super Admin staff account review, role change, activation, and deactivation UI is available. Customer and staff invitation creation and acceptance flows are implemented; automatic delivery remains disabled until the Resend account, sender domain, webhook, encryption key, and data-handling checks pass. Unknown delivery outcomes require reconciliation and are not automatically retried.

## MFA-complete staff sessions

`staff_mfa_session` has `session_id` as its primary key and foreign key to `auth_session(id) ON DELETE CASCADE`, plus user ID, method (`TOTP`, `BACKUP_CODE`, or `OTP`), and verification time. The dedicated `gphkm_mfa_proof` role writes proof only after a successful Better Auth verification endpoint and resolves the actual session from the issued/current signed cookie. The normal runtime can read proof for authorization but cannot insert or update it. The staff guard requires an active staff role, user MFA enabled, and a matching `(session_id, user_id)` proof row. Migration `0072` permits the narrow proof function to record verified sessions for inactive staff so invited or deactivated staff can complete MFA and await activation; this grants no staff data or command access. Deleting/revoking the Better Auth session cascades the proof.

The auth catch-all accepts only exact configured customer/staff hosts from `CUSTOMER_APP_URL` and `STAFF_APP_URL`, uses separate Better Auth instances and trusted origins, and leaves cross-subdomain cookies disabled. Surface guards re-check the direct `Host` header; forwarded host headers are ignored. Local test hosts use distinct `*.localhost` names. Google OAuth must register the callback URL for each surface.

## Tenant context contract

Every customer organization transaction sets `app.user_id` transaction-locally. Membership reads allow that actor to see their own memberships. The application checks an active membership before setting `app.organization_id`; only then may the transaction read or write tenant rows. All statements in the unit of work use the same transaction connection. Never set a tenant context from an unverified session or pass caller-supplied context directly to SQL.

Organization creation is the only exception before membership exists: set `app.user_id`, insert an organization whose `created_by` equals that user, insert that same user as active `OWNER`, and create its wallet plus audit event atomically. Use a unique `created_by` index to close concurrent first-organization races. The RLS insert policy must check `created_by = app.user_id`; subsequent membership-based access starts only after the owner row exists.

Customer onboarding is available only to a verified customer host session and is idempotent under concurrent requests. The route checks exact `Origin`, caps the request body, and renders no customer workspace content before the first organization exists. Versioned Terms/Privacy consent persistence is implemented in migration `0013_customer_legal_consent.sql` and enforced before onboarding/protected actions. Public signup remains blocked until approved legal copy, document URLs, and immutable version identifiers are configured.

## Appearance preference

`user_appearance_preference` stores one `DARK` or `LIGHT` choice per authenticated user. Migration `0071` enables RLS and grants the normal runtime only self-row `SELECT`, `INSERT`, and `UPDATE`; delete is revoked. Customer saves require a verified customer session. Staff saves require an active, MFA-verified staff session. This setting is presentation-only and does not grant access or alter organization settings. Migration `0072` adds the separate inactive-staff MFA proof behavior described above.

## Better Auth core-table boundary

`auth_user`, `auth_account`, `auth_session`, `auth_verification`, and `auth_two_factor` are global Better Auth records and are not tenant-RLS tables. Better Auth needs email/account lookups before authentication and session lookup before `app.user_id` can be trusted. Keep these queries behind server-side Better Auth and identity modules, use parameterized ORM operations, apply the configured host/trusted-origin and session checks, and never return raw account/session/verification records from application routes. `auth_rate_limit` and `auth_staff_rate_limit` are also global operational counters; their separate tables prevent one surface from exhausting the other's bucket.

## Security tests required at integration

- User sees own membership list, not another user's rows.
- Wrong tenant context returns no rows and rejects writes under the restricted runtime role.
- Unverified user cannot create an organization or accept an invitation.
- Invitation cannot be accepted by a different verified email, after expiry, or after revoke; token hash is single-use.
- Concurrent first-organization attempts create exactly one organization.
- Staff with no session proof, inactive staff, disabled MFA, mismatched user/session proof, or revoked session is denied.
- Successful TOTP, OTP, or backup-code verification produces proof for exactly the resulting session only.
