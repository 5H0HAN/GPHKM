# ADR-0027: Staff customer directory and access management

**Status:** Accepted
**Date:** 2026-10-31

## Context

Admin and Super Admin need one place to find customers and review operational context when handling Support and account-access requests. The customer and staff authority domains remain separate. Finance is not assigned routine customer support and must not receive a global customer identity search. Profile and credential changes remain customer-managed.

## Decision

- Add a staff-only customer directory and customer detail view. Grant `customer.directory.read` and the separate `customer.account.manage` permission to Admin and Super Admin only; enforce them in each server query/command service and recheck active staff role in PostgreSQL. Hide the navigation item from Finance, and deny direct route access.
- Search by customer name, email, and organization name. Paginate server-side. Include only customer identity fields, organization name/role/membership status, paid-order customer status/item count, customer-opened Support summaries, organization closure requests, and the current shared USD wallet balance for each open organization where the customer has an active membership. Balance reads are separately audited through a narrowly allowlisted database projection.
- Allow Admin and Super Admin to change the role and active state of an existing organization membership. Do not create memberships or invitations. Keep the last active Owner protected; serialize transitions on the organization and recheck the locked state in PostgreSQL.
- Allow Admin and Super Admin to suspend or reactivate customer access. Suspension blocks new sessions, revokes existing sessions in the same database command, and is checked on every protected customer request. Existing orders and funds are unchanged. Reactivation requires a new customer sign-in.
- Require a bounded reason code, explicit confirmation in the UI, expected-current-state checks, and append-only audit for membership and account-state changes. Runtime privileges do not grant direct updates to membership or account-control tables.
- Do not permit staff to edit customer profile/email, reset credentials, delete customers, view billing profiles, inspect wallet holds, ledger entries, recharge history, payment evidence, or access order content through the directory. Existing Support, closure, and assigned fulfillment workflows remain the management surfaces for those records.

## Consequences

Admins can locate customers, see a shared organization balance summary, and make support-authorized account or membership changes from a single auditable workflow. A displayed balance belongs to the organization, not the individual. Suspension does not silently cancel work or alter wallet funds. Finance remains unable to list or identify customers from this surface. Authentication recovery and customer profile settings remain in the customer authority domain.
