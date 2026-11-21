# ADR-0038 · Preliminary notices for designated staging Google testers

Accepted by the project owner on 2026-11-19 for the isolated demo.

This limited tester flow is retained for use when explicitly configured. The staging-wide review-draft signup decision in [ADR-0040](ADR-0040-open-customer-staging-signup.md) supersedes its tester-list requirement for general staging access.

The owner wants to exercise customer registration and wallet settlement before final legal review. In staging, a designated Google tester may explicitly accept the following preliminary documents on the configured customer HTTPS origin.

| Document | Immutable version |
| --- | --- |
| Demo Terms | `terms-staging-testers-2026-11-19-v1` |
| Demo Privacy notice | `privacy-staging-testers-2026-11-19-v1` |

Serve each document at `/legal/testing/<version>`. Preserve each published version and issue a new ID when the text changes. Record the tester's acceptance, exact URLs, versions and server timestamp through the existing consent flow. The separate review drafts remain available under `/legal/drafts/`.

Require an explicit staging setting, exact server-configured tester addresses, verified Google identity and disabled live-money gates. Restrict protected access when a tester leaves the configured list. Use synthetic organization and order data and Stripe sandbox funds. Keep staff authentication and its MFA requirement independent.

The four approved public document settings remain reserved for reviewed, published documents. Public signup and real-money launch remain subject to [ADR-0013](ADR-0013-versioned-customer-legal-consent.md) and [L-10](../OPEN_DECISIONS.md). The [staging runbook](../STAGING.md) covers enabling and closing tester access.
