# ADR-0016: Enforce identity transitions in PostgreSQL

- **Status:** Accepted
- **Date:** 2026-10-29
- **Decision owner:** Project owner

## Context

Application checks for staff activation, role changes, member promotion/removal, and invitation acceptance did not prevent a direct update through the general database runtime role. That could bypass last-Owner and last-Super-Admin checks, session revocation, or audit recording. Staff-host Google sign-in could also create an uninvited user account, even though it did not grant staff authority.

## Decision

- Revoke runtime `UPDATE` on `staff_account` and `organization_member`.
- Expose only narrow security-definer commands for promotion, removal, invitation acceptance, staff activation, staff role change, and staff deactivation. Each command validates the current actor and transition, writes its audit event in the same transaction, and revokes affected staff sessions where required.
- Preserve the last active Owner and last active Super Admin. Do not permit runtime assignment of the Super Admin role.
- Limit direct organization-member insertion to the creating user becoming the first Owner. Invitation acceptance uses its own database command, which locks the organization before the invite/member rows so it serializes with closure.
- Recheck Owner/Super Admin authority after acquiring the locks that serialize the relevant transitions. Staff role, activation, and deactivation commands share an advisory lock, and their application callers do not pre-lock target rows.
- Permit new staff-host OAuth user creation only when the verified email matches a current pending staff invitation. Existing users still require an active staff record and exact session MFA proof for protected actions.
- Source costs are not mapped from supplier imports in v1. Finance enters them separately after draft listing creation; costless listings remain provisional until reviewed.

## Consequences

- Server commands call the narrow database functions instead of updating authority tables directly.
- Migrations `0076_identity_transition_commands.sql` and `0077_identity_authority_lock_rechecks.sql` are part of every environment rollout. The database function definitions and execute grants are reviewed together with their server call sites.
- Raw source files remain restricted because they can contain unmodeled cost and supplier data.
