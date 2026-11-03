# ADR-0030: Super Admin self-assignment of fulfillment work

- **Status:** Accepted
- **Date:** 2026-11-03
- **Decision owners:** Product / Engineering / Security

## Context

The fulfillment queue assigns work to active Admin accounts. Super Admins can already access and audit every item, but cannot record themselves as the operational owner. This prevents a logged-in Super Admin from taking accountable ownership through the same assignment workflow.

## Options considered

- Keep assignment Admin-only and leave Super Admin ownership implicit in audit events.
- Permit Super Admins to assign any active Super Admin, expanding the assignment target policy.
- Permit a Super Admin to assign only themself, while retaining active Admins as the other assignable accounts.

## Decision

Allow an active Super Admin to self-assign an item. Any changed assignment to another account remains limited to active Admins. Staff may resubmit an unchanged assignment to an existing Super Admin so the queue can preserve the current selection safely. The database command enforces this rule after locking and validating the actor and target staff rows, then records actual changes in the existing append-only audit event with a `SUPER_ADMIN_SELF_ASSIGNMENT` reason.

## Consequences

The assignment field records operational ownership without changing Super Admin's existing role-wide access. Admin access remains limited to currently assigned work. The queue exposes a self option only to the active Super Admin making the request and preserves an existing Super Admin assignee as an unchanged option. Assignment does not bypass holds, content approval, recipient consent, handoff cutoff, or delivery requirements.

## Revisit trigger

Revisit if the project introduces an explicit duty roster, on-call rotation, or a need for Super Admins to delegate work directly to other Super Admins.
