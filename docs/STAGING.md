# Demo staging operations

Use the existing GPHKM_Staging project and its staging environment. The gphkm-demo application uses the installed GitHub App, repository 5H0HAN/GPHKM, branch main, base directory / and Compose file /compose.staging.yaml. A push to main is the deployment trigger. Keep preview deployments disabled.

| Surface | Runtime configuration | Staging URL |
| --- | --- | --- |
| Landing page and signed webhooks | GPHKM_PUBLIC_BASE_URL | https://gphkm.asf.run |
| Customers and Google callback | CUSTOMER_APP_URL | https://app.gphkm.asf.run |
| Staff password and authenticator | STAFF_APP_URL | https://staff.gphkm.asf.run |

Point the three DNS names at the staging host. In Coolify assign the three HTTPS domains to service web on internal port 3000. The proxy terminates TLS. Keep host ports closed for web and PostgreSQL. Set GPHKM_TRUSTED_PROXY_CIDRS to the actual Traefik hop after inspecting its network attachments, and recheck after changing the proxy or network. Traefik must discard untrusted forwarded headers. Check HTTP redirects, valid HTTPS, the landing-page sign-in destination, protected route redirects, and the database-backed /api/health endpoint after deployment.

## Database and secrets

Store all secrets as runtime-only application variables. Generate separate random alphanumeric values for SERVICE_PASSWORD_POSTGRES, SERVICE_PASSWORD_MIGRATION, SERVICE_PASSWORD_RUNTIME, SERVICE_PASSWORD_MFAPROOF, SERVICE_PASSWORD_STRIPEWEBHOOK, and a stable 64-character SERVICE_PASSWORD_64_AUTH. Back up the auth secret privately before enrolling staff. Recovering from a database or key loss requires both the original database and matching auth secret. To rotate a database password on an existing volume, coordinate ALTER ROLE with the Coolify secret update.

The one-shot migrate service runs before web. It takes an advisory lock for migrations and seeds three fictional publications and one private supplier transactionally. The seed keeps staff edits across redeploys. The staging catalog uses reserved domains, a non-login audit actor and zero wallet credits. Check migration service logs after first deploy. No email worker, external supplier delivery, or private object storage is enabled for this demo.

Bootstrap the first Super Admin once on the staging host after verifying the operator controls the mailbox. From the application's generated Compose directory use the following command in a Bash terminal. Enter the fresh password at the hidden prompt and store it in the operator's password manager. The bootstrap refuses an existing staff setup or an email already in use.

```bash
read -r -p 'Verified operator email: ' GPHKM_STAGING_ADMIN_EMAIL
export GPHKM_STAGING_ADMIN_EMAIL
read -r -s -p 'New staff password (16 to 128 characters): ' staging_password
printf '\n'
printf '%s' "$staging_password" | docker compose run --rm --no-deps -T -e GPHKM_STAGING_ADMIN_EMAIL migrate node scripts/bootstrap-staging-admin.mjs --mailbox-verified
unset staging_password GPHKM_STAGING_ADMIN_EMAIL
```

Sign in on the staff host, enroll an authenticator, and save the recovery codes privately. Staff authority requires factor proof for that exact session.

## Providers and acceptance

Keep Google Auth Platform in Testing. The dedicated Web client uses the exact customer origin and its /api/auth/callback/google redirect. Store GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET at runtime. Use designated test accounts only.

Configure STRIPE_SECRET_KEY with a sandbox restricted key and STRIPE_PUBLISHABLE_KEY with its sandbox publishable key. Use only Checkout Sessions Write, Events Read and Payment Intents Read, scoped to the staging server's outbound IP. Register a dedicated snapshot endpoint at the public origin's /api/payments/stripe/webhook, match the SDK API version and seven events in the [sandbox runbook](STRIPE_SANDBOX_RUNBOOK.md), and store that endpoint's STRIPE_WEBHOOK_SECRET. Verify a test top-up as a test organization Owner by reconciling one signed success event to one settled attempt and one ledger credit. The browser redirect alone cannot demonstrate settlement.

The [publication template](legal/LEGAL_PUBLICATION_TEMPLATE.md) records the review needed for Terms and Privacy. Review-only drafts have versioned paths under /legal/drafts/ on the customer host. Set the four approved document variables only when the published documents and immutable version IDs are approved for the intended audience. Keep the real-money flags false throughout staging.
