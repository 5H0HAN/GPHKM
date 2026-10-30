# ADR-0022: Require fresh authentication for customer session revocation

**Status:** Accepted
**Date:** 2026-10-29

## Context

Revoking another device is a sensitive account action. A stolen long-lived session must not be enough to sign out a customer's other devices. The current Better Auth version exposes a fresh-session check based on the auth session's creation time, and its session-list endpoint enforces that check.

## Decision

Configure Better Auth `session.freshAge` to 10 minutes. Customers may review active session metadata without this freshness requirement. The shared customer auth `before` hook must also guard all built-in revocation paths (`/revoke-session`, `/revoke-other-sessions`, and `/revoke-sessions`) because the latter endpoints only require a valid session in Better Auth. This applies to both catch-all HTTP requests and server-side `auth.api` calls. Single-session revocation obtains the target through Better Auth's fresh-gated session list; bulk revocation calls that endpoint before `revokeOtherSessions` as defense in depth.

If the current session is older than 10 minutes, show a prompt to sign in again with Google before revocation. Keep tokens server-side and do not include them in session-list projections.

## Consequences

Customers can review active sessions at any time, while every revocation route requires a recent identity-provider sign-in. The shared hook fails closed if the session headers or creation time are missing or invalid. Better Auth freshness uses session creation time, so routine session refreshes do not extend the window. Changing the window requires updating this ADR, the product/security documentation, and the auth configuration together.
