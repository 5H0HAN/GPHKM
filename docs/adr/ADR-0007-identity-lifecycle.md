# ADR-0007: Customer organization and staff identity lifecycle

- **Status:** Accepted
- **Date:** 2026-10-28
- **Decision owners:** Product / Security / Operations

## Context

GPHKM has organization-owned wallets and orders, multiple customer roles, and separate staff authority. Signup, invitation, ownership transfer, and staff provisioning must be defined before building authorization.

## Options considered

- One organization per user: simple, but does not support agencies or users invited to multiple customers.
- Multiple memberships with verified-email invitations: supports organization-based accounts while preserving tenant boundaries.
- Public staff signup or custom roles: adds unnecessary access paths and permission complexity.

## Decision

- Verified customer signup creates an organization and first Owner. A user may join multiple organizations and switches an active organization context. Joining another organization requires an invitation accepted by the same verified email; invitations expire after seven days, default to Member, and can be revoked.
- Owners may promote an active Member to co-Owner. The last Owner cannot leave or be removed until ownership transfers.
- Organization closure is Support-managed in v1. Do not complete closure while active orders/disputes remain or the wallet balance is nonzero, except for a legally required exception. No voluntary cash-out is provided. An approved closure revokes access while required order, financial, and audit records are retained and personal data is minimized as law allows.
- Public staff signup is disabled. Bootstrap the first Super Admin through a one-time controlled setup. Super Admin invites staff. Each ordinary staff account holds exactly one of Admin or Finance; Super Admin is the only all-access role. Require staff MFA and revoke sessions upon deactivation.

## Consequences

- Every customer request resolves one active organization membership; organization switching cannot rely on a client-supplied organization ID.
- Invitation and ownership changes require audited commands and RLS coverage.
- Staff and customer authentication remain separate authority domains.
- Exact organization-closure retention periods remain a legal/finance launch gate.

## Revisit trigger

Revisit if GPHKM adds self-service organization creation beyond first signup, custom staff permissions, external staff SSO, or a customer-managed organization deletion workflow.
