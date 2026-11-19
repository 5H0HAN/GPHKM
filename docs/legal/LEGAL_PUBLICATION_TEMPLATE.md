# Terms and Privacy publication template

This is an operational template for collecting the final documents' URLs and immutable version IDs. It is not legal advice or approved customer-facing policy text. Do not publish these prompts as GPHKM terms or enable public signup from them.

## Local development

The local application is already wired to development-only placeholder pages:

```dotenv
GPHKM_TERMS_URL=http://localhost:3000/legal/terms
GPHKM_TERMS_VERSION=local-test-v1
GPHKM_PRIVACY_URL=http://localhost:3000/legal/privacy
GPHKM_PRIVACY_VERSION=local-test-v1
```

These settings are present in `.env.example` and the private local `.env`. The routes say they are nonbinding and return 404 outside development. `local-test-v1` must never be used for staging or production acceptance.

The isolated staging demo has a separate [designated Google tester exception](../adr/ADR-0038-staging-tester-notices.md). Its preliminary notices have a dedicated version namespace and require each tester’s own acceptance.

## Approved public documents

Complete this block only after legal approval and after the customer domain is chosen. The `app.` hostname is the planned customer origin; replace `<approved-domain>` with the actual domain.

```dotenv
GPHKM_TERMS_URL=https://app.<approved-domain>/legal/terms
GPHKM_TERMS_VERSION=terms-YYYY-MM-DD-v1
GPHKM_PRIVACY_URL=https://app.<approved-domain>/legal/privacy
GPHKM_PRIVACY_VERSION=privacy-YYYY-MM-DD-v1
```

Use distinct, immutable IDs for the two documents. Bump the corresponding ID whenever its published text changes. Keep the previous document available for the period set by Legal; existing acceptance records preserve the URL and version a customer accepted.

| Document | Approved public URL | Immutable version ID | Approved by | Approval date | Effective date |
|---|---|---|---|---|---|
| Terms | `https://app.<approved-domain>/legal/terms` | `terms-YYYY-MM-DD-v1` | `<legal approver>` | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` |
| Privacy | `https://app.<approved-domain>/legal/privacy` | `privacy-YYYY-MM-DD-v1` | `<privacy approver>` | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` |

## Legal review checklist

### Terms

- Contracting entity, eligibility, governing law, and dispute/support contact.
- Wallet funding, non-expiring balances, no voluntary cash-out, refunds, cancellation cutoffs, and required legal or processor exceptions.
- Placement and optional writing stages, customer content rights, publication-partner sharing, acceptable content, and the absence of an SEO or ranking guarantee.
- Support process, service limitations, suspension/closure, changes to terms, and effective dates.

### Privacy

- Data collected and its purposes, including account, organization, billing profile, order/content, support, security, and payment metadata.
- Service providers and recipients, including Google, Resend, Stripe, hosting/database, and publication partners; state what each receives.
- Retention/deletion periods, cross-border processing, security practices, cookies/session data, user rights, and contact details.
- Any legally required disclosures or exceptions that affect account closure, wallet records, or order evidence.

## Release steps

1. Have qualified counsel and Finance complete and approve the actual text; record approver and dates above.
2. Publish each final document on the permanent HTTPS customer origin and verify it opens without a session.
3. Set the four environment variables above in the staging secret/config store. Keep the local placeholder values in the local `.env` only.
4. Run the customer signup and protected-action consent checks against the published versions. Confirm that acceptance records contain the exact URL and version ID.
5. Update [ADR-0013](../adr/ADR-0013-versioned-customer-legal-consent.md) and [Open decisions L-10](../OPEN_DECISIONS.md#required-before-real-money-production) with the approved values. Do not mark L-10 complete until both documents are approved and published.
