# Operations and Quality Standards

## 1. Engineering and product standards

Follow the build sequence in [Implementation Guide](IMPLEMENTATION_GUIDE.md), the [RBAC Matrix](RBAC_MATRIX.md), and [Threat Model](THREAT_MODEL.md).

- Use strict typing and runtime validation at request, webhook, file, and job boundaries.
- Keep business rules in server-side domain modules; do not expose raw database entities.
- Use exact money and explicit status transitions. Critical changes are commands, not generic updates.
- Keep migrations, runtime credentials, and production secrets separate.
- Design responsive customer/admin routes toward WCAG 2.2 AA.
- Never represent an unknown direct cost as zero or a later availability check as a rewrite of original completion evidence.

## 2. Required checks when implementation begins

The GitHub Actions workflow uses commit-pinned actions, scans full repository history for secrets, runs a high-severity npm advisory gate, lint, TypeScript checking, the Node test suite, and a production build on pushes and pull requests. It generates distinct temporary credentials for all database roles, starts an isolated PostgreSQL container, applies all migrations, and runs `npm run db:check-rls:local` with the restricted runtime role plus the disposable-database `npm run db:check-content-race:local` concurrency regression. Before creating the bootstrap Super Admin, CI runs `npm run db:check-auth-recovery:local` against the live HTTP app so the disposable database can exercise successful break-glass recovery as well as the password-capable-peer guard, customer TOTP, and reset host isolation. It then creates random local-only customer and Super Admin fixtures and runs `npm run db:check-session-guard:local` to verify customer workspace access, customer-to-staff page and API denial, and stale-session rejection on every direct revocation endpoint. `npm run db:check-staff-auth:local` runs after bootstrap for the development-only password bypass; `npm run db:check-staff-mfa:local` exercises TOTP, exact-session proof, denial without proof, and cross-surface cookie isolation. The ephemeral database is removed even after a failed step. CI keeps both real-money flags false. The RLS smoke command rolls back its synthetic fixture data; the session probe deletes the temporary customer session it creates. Moderate/low advisories remain visible in the audit output for review and should not be force-fixed when npm's proposed change breaks supported dependency ranges.

Before release, also run `npm run db:check-content-race:local` against a local PostgreSQL migration role. It creates and drops a separate disposable database, applies all migrations, and uses separate runtime connections to race a consent insert against supplier handoff in both commit orders. The RLS smoke includes assignment authority/audit, runtime column privileges, and Stripe failed-refund grant recovery checks. These local database checks use synthetic data only; they do not call Stripe or verify production provider behavior.

CI should include as appropriate to the selected stack:

- Formatting, lint, type checking, and production builds.
- Domain tests for money, access grants, order transitions, refund limits, and cost provisional state.
- PostgreSQL integration tests for constraints, transactions, and restricted-role RLS.
- Authorization tests for organization Owner/Member and Admin/Finance/Super Admin.
- Identity tests for multi-organization context, verified-email invitation expiry/revocation, last-Owner protection, staff bootstrap/deactivation, and exclusive Admin/Finance role bundles.
- Payment tests for exact amount/currency match, webhook replay, timeout recovery, and reconciliation.
- Import tests for bounds, formula safety, fixed-endpoint Sheets SSRF protection, staged selected-row apply, duplicate handling, and idempotent replay.
- Workflow tests for item transition allowlists, cancellation cutoffs, writing-stage credits, Support-case authority, content-version consent, provider-accepted versus delivered handoff, and completion correction without evidence overwrite.
- Security regressions for sensitive-field projection, access expiry, URLs, handoff, exports, CSRF, rate limits, and staff revocation.
- Dependency, migration, license, and secret scanning.

## 3. Code review and change control

Require review for auth, permissions, RLS, wallet/payment, migrations, imports, exports, publication evidence, and deployment secrets. PRs should state user impact, data/money changes, tests, rollout/rollback, and monitoring. Keep an ADR for long-lived product or architecture decisions.

For customer, staff, or public UI work, follow the [Frontend UX workflow](FRONTEND_UX_WORKFLOW.md). Keep the approved product and design docs authoritative, inspect the rendered route at desktop and mobile widths, and attach screenshots for the changed surfaces to the review. UI work must preserve server-side authorization and the customer/staff data boundary.

## 4. Environments and release

Separate local, test, staging, and production credentials, databases, payment accounts, callback secrets, and object-storage buckets. Use test payment accounts outside production. Keep runtime database identities restricted; migrations use a separate elevated identity.

Production authentication requires `GPHKM_TRUSTED_PROXY_CIDRS`, a comma-separated list of the exact reverse-proxy IPs/CIDRs that may appear in `X-Forwarded-For`. Keep the app origin firewalled to those proxies, configure the proxy to overwrite or sanitize forwarded client-IP headers, and validate rate limiting through the real proxy chain before launch. Never use `0.0.0.0/0` or `::/0`.

Real-money checkout remains disabled until state/entity details, provider account configuration, and qualified legal/finance review are complete. Set support hours and RPO/RTO before production.

Page responses receive a per-request nonce-based Content Security Policy through the Next.js Proxy. Stripe's hosted script, frames, and API connections are allowed only on the customer surface; the staff surface receives no Stripe script/connect/frame origins. Keep inline event handlers and style attributes out of rendered UI, and verify the policy against the Stripe Payment Element whenever Stripe changes the payment UI.

## 5. Observability

Use structured logs with safe request, actor, tenant, order, payment attempt, import batch, and provider-event correlation IDs. Redact personal details, credentials, payment data, supplier contacts, spreadsheet rows, and article content.

Track authorization denials, wallet/provider reconciliation, pending payment aging, import review age, order milestones/overdue work, supplier response, publication evidence, packet send/delivery/unknown states, unmatched handoff events, manual exports without send evidence, worker retries/outbox age when a worker exists, database health, storage access, and backup age.

The staff fulfillment queue defaults to active items, excluding `COMPLETED` and `CANCELED_REFUNDED`. Select All items (`view=all`) to find completed/refunded history alongside active work. Both views use server-rendered pages of 100 with Previous/Next retaining the selected view. Items sort by next-update date (missing dates last), then most recently updated, with item ID breaking ties; the item count covers the selected view across all pages, while overdue counts always cover authorized active work only. Counts and pages refresh on each request, so changed assignments, dates, or states can move items between pages.

Staff catalog listings and supplier directories use server-rendered pages of 50 with stable update-time and ID ordering. Counts and pages refresh on each request; supplier lookup choices used by listing and import forms remain available independently of the paged directory.

The staff overview shows role-scoped live queue alerts for overdue customer updates, supplier handoff reconciliation, Stripe event exceptions, open funding attempts, and unresolved wallet findings. Each alert links to its authoritative review queue and counts refresh on page load. Keep database, host, and backup alerts in Coolify monitoring and route them to the operations contact before production; add a separate monitoring service only if these providers cannot cover the required signals. Never log order content, personal details, supplier contacts, secrets, or payment payloads.

## 6. Backup, recovery, and retention

Keep deployment topology, backup destinations, schedules, retention, credentials, and recovery evidence in the private operations record. Public runbooks describe the recovery procedure without exposing environment-specific infrastructure details. Resolve personal and financial data retention with Legal/Finance before production data is retained in backups; apply deletion decisions recorded after a backup before restored data is used.

For the current staging backup procedure and status, see [the staging runbook](STAGING.md). Keep a protected copy of the matching `BETTER_AUTH_SECRET` with recovery material. Restore to an isolated instance first, confirm migrations and restricted roles, and reconcile wallet ledger, orders, imports, and provider events before any live restore.

Back up private object-store import/evidence objects separately from PostgreSQL. Rehearse restoration of both stores together before production.

Retain financial and audit evidence as required by law. Retain final order/publication records as needed. Customer order content is text-only; there are no customer-uploaded order attachments in v1. Minimize or delete private briefs and drafts when fulfillment/dispute needs end. Apply separate retention rules to staff inventory uploads, staff-only handoff evidence, and generated packet PDFs. Set exact retention periods with legal/finance before production.

### Auth recovery

Use the verified customer or staff app origin for password reset. A reset invalidates existing sessions. Customer TOTP enrollment remains intact. Staff sign-in requires TOTP or a one-time backup code and exact-session proof. Keep customer backup codes in a protected location. Each code can be used once.

| Situation | Recovery path |
|---|---|
| Customer forgot their password | Request a reset from the customer sign-in page, follow the email link, and sign in with the new password. |
| Customer lost their authenticator and has a backup code | Sign in with email and password, then use a backup code. |
| Customer lost their authenticator and all backup codes | No self-service or staff reset is available in v1. |
| Google-only customer wants TOTP | Add a password in Settings and enroll an authenticator. |
| Google-only customer lost Google access | Recover the Google account. The GPHKM account remains inaccessible unless a password was added earlier. |
| Staff forgot their password | Request a reset on the staff sign-in page, then sign in with the new password. |
| Staff lost their authenticator and has a backup code | Sign in with password and the one-time backup code. |
| Staff lost their authenticator and all backup codes | Another active Super Admin resets the factor; the staff member resets the password if needed, signs in, and re-enrolls. |
| Staff account is inactive | A different active Super Admin activates it after verified email and TOTP. |
| Super Admin forgot their password | Use the staff reset email. |
| Super Admin lost their authenticator | Another active Super Admin resets the factor and sessions; the target signs in and re-enrolls. |
| Super Admin lost both password and authenticator, while another capable Super Admin exists | The other Super Admin resets TOTP; the target uses password reset if needed, then signs in and re-enrolls. |
| Last capable Super Admin lost both factors, or all Super Admins are locked out | Use the audited migration-role break-glass CLI. |
| No active Super Admin, with an inactive Super Admin on record | Recover that Super Admin through the audited migration-role CLI. |
| Database, app, infrastructure, auth secret, and all recovery channels are lost | No software can guarantee recovery. |

#### Emergency Super Admin command

1. Confirm the target is an existing Super Admin and record the incident and recovery reason. Use email reset first when the target can access the invited address.
2. Use an operator session with the approved migration-role `MIGRATION_DATABASE_URL`. Supply a new 16–128-character password through stdin from a protected secret source. Do not pass a password as a command argument, shell literal, or exported environment variable. The command rejects terminal input.
3. Replace the command and user ID placeholders below. This example loads the migration URL from the protected environment file. Use a session-scoped flag for this command only.

```sh
read-recovery-password-from-secret-manager | \
  GPHKM_BREAK_GLASS_RECOVERY=true node --env-file=.env scripts/recover-super-admin.ts \
    --user-id '<SUPER_ADMIN_USER_ID>' --reason AUTH_RECOVERY --confirm
```

4. Confirm the `super_admin_break_glass_recovered` result and the `staff.break_glass_recovered` database audit event. Verify the target signs in on the staff host. The command replaces the password hash, clears any legacy factors and pending verification challenges, revokes sessions, and reactivates the target. The audit event records the target and reason with no web actor.

Keep `GPHKM_BREAK_GLASS_RECOVERY` out of persistent app and worker configuration. The database grants the function to its migration owner only. Recovery is refused while another active Super Admin has a verified email and a credential password, so staff access remains available through that account. A legacy TOTP record alone does not establish password sign-in capability. If recovery is refused, use the existing active Super Admin for staff continuity and have the target use the normal email reset; retry break-glass only when no other password-capable Super Admin remains.

Keep `BETTER_AUTH_SECRET` stable in the deployment secret manager and maintain a protected backup with the database recovery material. Rotating the secret invalidates existing TOTP secrets and backup codes. Rehearse restoring both the database and its matching secret. Never log passwords, hashes, reset or invitation URLs, tokens, TOTP secrets, or backup codes. For the local synthetic fixture only, `npm run auth:seed-local-staff-mfa -- <staff-email> --show-secret` prints its reusable provisioning URI only in an interactive terminal; use it privately and never redirect or copy that output into logs or chat.

## 7. Runbooks required before launch

1. Stripe outage, duplicate event, ambiguous payment, dispute, refund, and reconciliation mismatch.
2. Wallet adjustment, reason/evidence requirements, and no direct balance editing.
3. Supplier spreadsheet import, conflict review, rollback/disable listing, and stale-source review.
4. Overdue publication, supplier nonresponse, pre-completion failure, customer update, pre-handoff cancellation, writing-stage refund, and wallet credit. After handoff/work start, follow the Support exception path; Finance or Super Admin must approve any item-specific wallet refund with evidence.
5. Staff account compromise, role revocation, credential rotation, and audit preservation.
6. Backup restore, failed deploy/migration, durable-job backlog if applicable, and email outage.
7. Customer complaint about a placement disappearing after valid completion: explain the disclosed lifetime-intent/no-guarantee term and record any known cause; do not promise a replacement or refund absent a legal/processor requirement.
8. Supplier email provider outage, unknown send, duplicate/bounce, delivery unconfirmed after 72 hours, manual EML/PDF export and attestation, and handoff reconciliation exception queue. Follow SUPPLIER_HANDOFF.md.
9. Incorrect publication completion report: preserve original verification evidence, open an audited correction case, and resume pre-completion failure handling. Do not confuse this with later disappearance after valid completion.
