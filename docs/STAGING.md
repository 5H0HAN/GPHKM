# Staging operations

This runbook is for the isolated demo and test environment. Do not use production credentials, customer data, or live payment settings.

## Readiness

| Check | Result |
|---|---|
| Main-branch deployment | PASS |
| Application health, migrations, and staging seed | PASS |
| HTTPS ingress and application security headers | PASS |
| Existing demo acceptance checks | PASS |
| Super Admin authenticator enrollment | PASS |
| Sandbox payment settlement | PASS |
| Database backup procedure and isolated restore rehearsal | PASS |
| Desktop and mobile review | PASS |
| Staging review Terms and Privacy pages | PASS |
| Restricted Resend key and one direct test send | PASS |
| Customer email/password signup, verification, and password reset | PASS |
| Google sign-in for non-listed accounts | PASS |
| App-triggered password-reset email delivery | PASS |
| App-triggered verification email delivery | PASS |
| Welcome email after customer verification | FAIL |
| Staff invitation delivery and acceptance | FAIL |
| Approved production Terms and Privacy | FAIL |

Overall staging demo checks: PASS. Expanded signup and mail acceptance: FAIL. Production readiness: FAIL.

FAIL means the requirement is not currently demonstrated. This includes acceptance that has not yet been verified.

## Deploy and verify

1. Merge a reviewed pull request to `main` after all required quality checks pass.
2. Confirm the connected deployment completes and the application reports healthy.
3. Check the configured health endpoint and database readiness.
4. Confirm migrations and staging seed complete before serving application traffic.
5. Keep preview deployments disabled unless separately reviewed for staging.

## Staging access, mail, and payments

1. Keep staging review notices enabled, tester notices disabled, and real-money and launch-gate flags false.
2. Store provider credentials as runtime-only deployment secrets. Use a sending-only key restricted to the verified sender domain. Configure separate system and support sender addresses, and keep invitation encryption keys separate from provider credentials.
3. Enable the mail data-handling flag only after the staging data-handling review is accepted. Configure any signed provider webhook secret only on the web service.
4. Confirm the background worker and its restricted database role are healthy before testing. The worker must not expose a public port.
5. Test a non-listed Google account, a new email/password account, verification, sign-in, password reset, customer invitation, and staff invitation. For staff, verify invitation email, password setup, authenticator enrollment, and Super Admin activation. Keep passwords and authenticator codes private.
6. Use sandbox payment credentials, synthetic organization/order data, and fictional content. Staging acceptance of review drafts does not approve them for production.
7. To close general signup, disable the staging review-notice flag, clear `GPHKM_TERMS_URL`, `GPHKM_TERMS_VERSION`, `GPHKM_PRIVACY_URL`, and `GPHKM_PRIVACY_VERSION`, then redeploy. Disabling the review flag alone can leave signup open if fallback legal values remain configured. Keep tester-notice mode disabled unless a separately approved allow-listed test requires it.

The staging Google OAuth project uses the In production audience so non-listed Google accounts can reach the staging sign-in flow. The shipped Google sign-in flow requests only the basic identity scopes `openid`, `email`, and `profile`, and the customer auth endpoint rejects caller-supplied custom Google scopes. Google may display an unverified-app warning. Keep the production OAuth client separate and complete applicable branding and policy review before production.

## Private file storage

1. Keep the R2 bucket private. Disable its public development URL and custom public domains, and keep browser CORS disabled. Restrict the access token to Object Read & Write on this bucket only; do not grant account-wide bucket administration.
2. Set `GPHKM_PRIVATE_STORAGE_DRIVER=r2`, `GPHKM_R2_ACCOUNT_ID`, `GPHKM_R2_BUCKET`, `GPHKM_R2_ACCESS_KEY_ID`, and `GPHKM_R2_SECRET_ACCESS_KEY` in the deployment secret store. Treat the access keys as secrets.
3. Keep these settings runtime-only, with build-time injection disabled. The staging Compose configuration masks the R2 variables from the database, migration, and role-provisioning services, and explicitly passes them only to the web app and notification worker. Keep preview environment copies disabled unless a separate preview bucket is reviewed and configured.
4. After deployment, upload one synthetic private file through the app. While it exists, if a public URL is configured, verify an unauthenticated request is denied; do not enable public access for this test. Otherwise, confirm the bucket's public endpoints are disabled and the app exposes no public object URL. Verify an authorized app read succeeds, then delete it and confirm it can no longer be read. Do not use real customer, supplier, or payment data for this check.

## Backup and restore

1. Confirm the database backup schedule is enabled and the latest run reports success.
2. Restore drills must target a new isolated volume; never restore over the active database.
3. Keep the restored database isolated while checking readiness, migrations, and seed state.
4. Remove temporary restore resources after the drill is complete.
5. Before production, configure independently protected recovery storage and complete a separate recovery review.
6. Keep at least one database recovery copy in a failure domain separate from the production database host.
