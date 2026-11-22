# ADR-0040 · Open customer signup for staging review

Accepted by the project owner on 2026-11-22 for the isolated staging service.

Staging may accept customer registrations from users outside the former Google tester list so the team can exercise email/password signup, email verification, Google sign-in, password reset, and customer workflows. Registration requires explicit acceptance of the staging Terms and Privacy review drafts. The drafts are published at stable staging-only routes, carry fixed internal acceptance identifiers, and are clearly marked as not approved for production. The page text and customer checkbox do not expose version IDs or dates.

Customer email and password reset messages use the configured `no-reply` sender. Organization and staff invitations are delivered through the database-backed worker using the same sender. Support case update messages use the configured `support` sender. Resend access uses a sender-domain-restricted sending key; webhook signing credentials remain on the web service and are not shared with the mail worker. Invitation tokens remain encrypted in the database outbox.

The shipped Google sign-in flow requests only the basic identity scopes `openid`, `email`, and `profile`; the customer auth endpoint rejects caller-supplied custom Google scopes. Keep the staging OAuth project in Testing: Google's audience guidance permits users outside the test-user list for this scope set. Do not publish the staging project as In Production; use a separate production project when that tier is prepared. Recheck audience and verification requirements before changing this scope policy. Staging payments remain sandbox-only. `GPHKM_REAL_MONEY_ENABLED` and `GPHKM_LAUNCH_GATES_VERIFIED` stay false.

This decision applies only to staging. Production customer signup, ordering, and wallet funding still require approved, published Terms and Privacy URLs and immutable version identifiers, completed privacy/legal and provider reviews, and the launch gates in [Open Decisions](../OPEN_DECISIONS.md). Draft acceptance never transfers to production.
