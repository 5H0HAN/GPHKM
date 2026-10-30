# ADR-0013: Versioned customer Terms and Privacy acceptance

- **Status:** Accepted implementation; approved legal documents remain a launch gate
- **Date:** 2026-10-28
- **Decision owners:** Product / Legal / Engineering

## Context

Customer onboarding and protected actions require consent to the current Terms and Privacy documents. No approved legal copy or publication URLs were provided during implementation, so the application must not invent policy text or silently treat a login as consent.

## Decision

- Configure the published Terms and Privacy URLs and immutable document versions through `GPHKM_TERMS_URL`, `GPHKM_PRIVACY_URL`, `GPHKM_TERMS_VERSION`, and `GPHKM_PRIVACY_VERSION`.
- Local development may use the development-only, explicitly nonbinding placeholder pages to exercise the consent flow. Those routes return 404 outside development and never satisfy a production legal launch gate.
- Fail closed for public customer Google sign-in and customer protected actions when any value is missing or invalid.
- Require an explicit checkbox at first organization onboarding. Re-prompt existing customers when either version or URL no longer matches acceptance evidence.
- Store acceptance by customer user, document versions and URLs, server timestamp, and actor. Keep acceptance append-only; a new document version creates a new acceptance record.
- Keep newsletter consent separate. Local test credential authentication remains available only under the existing local-development opt-in.

## Consequences

- Product cannot enable public customer signup, wallet funding, or ordering until legal copy is approved, published, versioned, and configured.
- URL changes require a version bump so acceptance never silently transfers to different text.
- Legal text remains outside the application bundle until the business supplies approved content and a hosting choice.

## References

- [Product specification](../PRODUCT_SPEC.md)
- [Open decisions and launch gates](../OPEN_DECISIONS.md)
- [Legal acceptance schema migration](../../src/db/migrations/0013_customer_legal_consent.sql)
