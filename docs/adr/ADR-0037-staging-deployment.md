# ADR-0037 · Isolated Coolify demo staging

Accepted for demo staging on 2026-11-19.

The project owner selected Coolify and GitHub App deployments from main. One Next.js process serves the landing page, customer workspace and staff console across three HTTPS staging origins. The request origin determines routing. The two sign-in surfaces retain separate host-only cookies, rate limits and server-side authorization.

The host ingress preserves the external Host and scheme and supplies the verified client address used by authentication rate limits. PostgreSQL remains unpublished.

Git-linked Compose runs one web container and PostgreSQL 17 on a persistent, unexposed volume. A one-shot container applies the migration journal and repeatable synthetic seed before web starts. The database owner, request runtime, Stripe webhook and staff MFA proof roles use distinct credentials. The staging definition disables live payments and development auth bypasses. Google uses a dedicated Testing client and Stripe uses a sandbox. The [designated tester exception](ADR-0038-staging-tester-notices.md) permits preliminary notices for sandbox use. Public legal approval and external delivery remain separately gated.

Production hosting, legal approval and sensitive provider delivery decisions remain open under O-01, O-05, O-06 and L-10. See the [staging runbook](../STAGING.md).
