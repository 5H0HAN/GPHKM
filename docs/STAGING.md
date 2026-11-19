# Demo staging operations

Use the existing GPHKM_Staging project and its staging environment. The gphkm-demo application uses the installed GitHub App, repository 5H0HAN/GPHKM, branch main, base directory / and Compose file /compose.staging.yaml. A push to main is the deployment trigger. Keep preview deployments disabled.

| Surface | Runtime configuration | Staging URL |
| --- | --- | --- |
| Landing page and signed webhooks | GPHKM_PUBLIC_BASE_URL | https://gphkm.asf.run |
| Customers and Google callback | CUSTOMER_APP_URL | https://app.gphkm.asf.run |
| Staff password and authenticator | STAFF_APP_URL | https://staff.gphkm.asf.run |

## HTTPS ingress

Point all three DNS names at the staging host. Host Caddy owns ports 80 and 443 and terminates TLS. Choose one available host TCP port for `GPHKM_STAGING_WEB_PORT`, set it as a non-secret Coolify application variable available during both build and runtime, and configure Caddy with the same value. Compose publishes web port 3000 exclusively on IPv4 loopback. PostgreSQL has no host port.

Configure Caddy to route the three exact HTTPS origins directly to web. Keep these sites out of the catch-all route to Traefik. If using Caddyfile environment substitution, supply the same three origins and the loopback port in the Caddy service environment.

```caddyfile
{$GPHKM_PUBLIC_BASE_URL}, {$CUSTOMER_APP_URL}, {$STAFF_APP_URL} {
    reverse_proxy 127.0.0.1:{$GPHKM_STAGING_WEB_PORT} {
        header_up X-Forwarded-For {http.request.remote.host}
    }
}
```

Caddy preserves the original Host, sets the forwarded scheme, and replaces incoming forwarded client addresses with the address of the connecting client. From the generated Compose directory, check `docker compose port web 3000` for the expected loopback binding. Web prefers its default bridge for the published port. Observe the peer on an incoming Caddy connection to web, set `GPHKM_TRUSTED_PROXY_CIDRS` to that individual bridge gateway address (/32 for IPv4), and recheck after a network change.

From a known external client, verify the HTTP-to-HTTPS redirect, certificate for each origin, public sign-in link, customer and staff sign-in pages, and database-backed `/api/health`. To verify client attribution, send an anonymous `GET /api/auth/get-session` request on each sign-in origin from two different known client IPv4 addresses. Confirm distinct counters for the two client addresses in `auth_rate_limit` and `auth_staff_rate_limit` for `/get-session`, with no increment for the gateway or `no-trusted-ip`. Verify Caddy's active configuration replaces incoming forwarded addresses and the loopback port is unreachable from an external client.

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

The [publication template](legal/LEGAL_PUBLICATION_TEMPLATE.md) records the review needed for Terms and Privacy. Review-only drafts have versioned paths under /legal/drafts/ on the customer host. For the isolated demo, leave the four approved document variables unset. Set `GPHKM_STAGING_TESTER_NOTICES_ENABLED=true` and list the exact designated Google test addresses in `GPHKM_STAGING_GOOGLE_TEST_EMAILS` (comma-separated) on web. Keep the Google Testing audience and this runtime list in sync. Redeploy after changing the list. Remove a tester from the app list to end their protected access.

Each tester opens customer signup, explicitly accepts the [demo Terms](https://app.gphkm.asf.run/legal/testing/terms-staging-testers-2026-11-19-v1) and [demo Privacy notice](https://app.gphkm.asf.run/legal/testing/privacy-staging-testers-2026-11-19-v1), then chooses the designated Google identity. Use a fictional organization and Stripe test details. Each notice URL and version is recorded with the tester's acceptance. To close all staging customer sign-in and existing session access, turn off the tester flag, keep the four public legal settings unset and redeploy. Keep both real-money flags false. See [ADR-0038](adr/ADR-0038-staging-tester-notices.md).
