# ADR-0013: Versioned customer Terms and Privacy acceptance

- **Status:** Accepted; approved legal documents remain a launch gate
- **Date:** 2026-10-28
- **Decision owners:** Product / Legal / Engineering

## Context

Customer onboarding and protected actions require consent to the current Terms and Privacy documents. No approved legal copy or publication URLs were provided during implementation, so the application must not invent policy text or silently treat a login as consent.

## Decision

- Configure the published Terms and Privacy URLs and immutable document versions through `GPHKM_TERMS_URL`, `GPHKM_PRIVACY_URL`, `GPHKM_TERMS_VERSION`, and `GPHKM_PRIVACY_VERSION`.
- Local development may use the development-only, explicitly nonbinding placeholder pages to exercise the consent flow. Those routes return 404 outside development and never satisfy a production legal launch gate.
- The [Terms and Privacy publication template](../legal/LEGAL_PUBLICATION_TEMPLATE.md) records the local test URLs/version IDs and provides production URL/version fields and a review checklist without inventing legal policy text.
- Fail closed for public customer signup (Google or email/password) and customer protected actions when any value is missing or invalid.
- Require an explicit checkbox with the current Terms and Privacy versions before creating a customer account by email or Google. Validate the versions on the server and store append-only acceptance evidence against the new user with a server timestamp and actor.
- Keep existing Google sign-in available without signup consent; disable implicit creation of new customer Google accounts so new users must take the explicit, consent-gated signup path. Carry the validated versions through Google's redirect only in Better Auth's signed server context.
- Reuse current signup acceptance during first organization setup. Re-prompt when either version or URL no longer matches acceptance evidence, and before protected actions.
- Store acceptance by customer user, document versions and URLs, server timestamp, and actor. Keep acceptance append-only; a new document version creates a new acceptance record.
- The Better Auth user-create hook records acceptance after the account row is created. If that evidence write fails, signup can report failure while leaving an unverified account. That account has no organization or protected access; after email verification, onboarding requires an explicit current acceptance and records it in the same transaction before creating the first organization. Keep a staging failure-path integration check before enabling public signup.
- Keep newsletter consent separate. Local test credential authentication remains available only under the existing local-development opt-in.

The owner approved a narrow [staging tester exception](ADR-0038-staging-tester-notices.md) on 2026-11-19. Public launch still requires final approval.

For the current staging rollout, [ADR-0040](ADR-0040-open-customer-staging-signup.md) allows customers to accept clearly labeled review drafts. This does not change the published-document requirement for production.

## Consequences

- Production customer signup, wallet funding, and ordering remain disabled until legal copy is approved, published, versioned, and configured. Staging may use the clearly labeled review drafts under [ADR-0040](ADR-0040-open-customer-staging-signup.md); that exception does not satisfy production approval.
- URL changes require a version bump so acceptance never silently transfers to different text.
- Legal text remains outside the application bundle until the business supplies approved content and a hosting choice.

## References

- [Product specification](../PRODUCT_SPEC.md)
- [Open decisions and launch gates](../OPEN_DECISIONS.md)
- [Legal acceptance schema migration](../../src/db/migrations/0013_customer_legal_consent.sql)
