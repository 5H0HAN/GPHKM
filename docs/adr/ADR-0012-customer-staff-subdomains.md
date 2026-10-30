# ADR-0012: Separate customer and staff subdomains

- **Status:** Accepted product direction; hostnames are environment-configurable, production values and deployment topology open
- **Date:** 2026-10-28
- **Decision owners:** Product / Engineering / Security

## Context

Customers and staff use different parts of GPHKM and have different authorization boundaries. A shared login surface risks confusing customers and staff about where to sign in. Serving staff operations from a dedicated subdomain also creates a clear entry boundary for staff-specific sign-in and MFA.

## Decision

- Serve the customer application and login page from a customer subdomain.
- Serve the staff/Admin/Super Admin application and login page from a separate staff subdomain.
- Keep one codebase, PostgreSQL database, and shared domain modules as the default. Decide whether both hostnames use one deployment or two deployments of the same codebase under O-06.
- Keep Better Auth session cookies host-only. Leave cross-subdomain cookies disabled; do not widen cookie scope to the parent domain for shared login.
- Configure exact trusted origins and explicit OAuth callback URLs for each environment. Do not trust wildcard subdomains or client-controlled forwarded-host values.
- Enforce organization membership, staff role, staff MFA, item assignment, and permissions server-side on every protected operation. The hostname is not authorization.

## Consequences

- A user signs in separately on each hostname; this is intentional session isolation.
- Better Auth base URL/origin configuration must be designed for the chosen deployment and host-routing model before production rollout.
- Customer/staff hostnames are configured per environment through `CUSTOMER_APP_URL` and `STAFF_APP_URL`. Production values, OAuth callbacks, and deployment topology remain O-06.
- DNS, TLS certificates, cookie behavior, CSRF/origin checks, callbacks, and unauthorized-role behavior must be verified for both entry points.
- Customer and staff screens can still share the same product code and server-side modules; this does not require microservices.

## References

- [Better Auth cookies and cross-subdomain cookies](https://better-auth.com/docs/concepts/cookies)
- [Better Auth security and trusted origins](https://better-auth.com/docs/reference/security)
