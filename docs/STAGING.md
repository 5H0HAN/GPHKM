# Demo staging operations

Use the existing GPHKM_Staging project and its staging environment. Coolify represents the app as one Compose resource; PostgreSQL runs as the `db` service in that Compose file and persists in the `staging-postgres` volume, not as a separate Coolify database resource. The gphkm-demo application uses the installed GitHub App, repository 5H0HAN/GPHKM, branch main, base directory / and Compose file /compose.staging.yaml. A merged change to main triggers Coolify's GitHub App webhook. Keep preview deployments disabled.

## Verified deployment state

Verified 2026-11-21 (Dhaka time): Coolify reports `gphkm-demo` as `running:healthy` in `GPHKM_Staging`. The application-code change in PR #31 (`3846a5c521c25f13323f9f97d86e659cb9a231cc`) deployed successfully through the GitHub App webhook. Subsequent main updates also triggered completed webhook deployments, including the runtime-image cleanup from PR #37 (`c9fa4e6e7b7ff2bc2bf9cd468c9c8f956fbb5bdc`) and the Trixie base-image change from PR #39 (`64c60adebdd2adb6b701e16aef02ca9b7e130a50`). After the latest deployment, `/api/health` returned HTTP 200 on the landing, customer, and staff hosts; this endpoint also checks a live database query. The Compose dependency graph starts web only after the migration and staging-seed service exits successfully. GitHub changes merge through a pull request with the branch current against `main` and the `quality` check green. Earlier visual checks loaded the public landing and customer/staff sign-in pages; their 390px layouts showed no obvious clipping. The staff sign-in page reports password reset unavailable because no staging email worker is configured. Full Google signup, tester notice acceptance, staff TOTP enrollment, and signed sandbox settlement still require the designated humans to complete the staging runbook steps below.

| Surface | Runtime configuration | Staging URL |
| --- | --- | --- |
| Landing page and signed webhooks | GPHKM_PUBLIC_BASE_URL | https://gphkm.asf.run |
| Customers and Google callback | CUSTOMER_APP_URL | https://app.gphkm.asf.run |
| Staff password and authenticator | STAFF_APP_URL | https://staff.gphkm.asf.run |

## HTTPS ingress

The three DNS names `gphkm.asf.run`, `app.gphkm.asf.run`, and `staff.gphkm.asf.run` point to the staging host at `129.146.102.189`. Host inspection confirmed Caddy owns public TCP ports 80/443 and terminates TLS; Coolify's Traefik proxy remains available for other routes. The GPHKM web container publishes port 3000 only at `127.0.0.1:18123`; PostgreSQL has no host port.

The active GPHKM site block in `/etc/caddy/Caddyfile` handles these three exact names, sets no-index and HSTS headers, replaces `X-Forwarded-For` with the connecting client's address, and proxies to the loopback web port. Keep this rule ahead of any catch-all route to Traefik. This is host-managed configuration outside the application repository; back it up, run `caddy validate`, and gracefully reload Caddy after changes.

```caddyfile
gphkm.asf.run, app.gphkm.asf.run, staff.gphkm.asf.run {
    header X-Robots-Tag "noindex, nofollow, noarchive"
    header Strict-Transport-Security "max-age=31536000"
    reverse_proxy 127.0.0.1:18123 {
        header_up X-Forwarded-For {http.request.remote.host}
    }
}
```

Do not add `includeSubDomains` or preload while this is a staging boundary. Browsers cache the one-year HSTS max-age after receiving it; reverting the file alone does not clear client policy. To retire it early, serve `max-age=0` over valid HTTPS on each hostname. See [Caddy's header directive](https://caddyserver.com/docs/caddyfile/directives/header) and [RFC 6797 §6.2](https://www.rfc-editor.org/rfc/rfc6797.html#section-6.2).

Checks on 2026-11-21 confirmed HTTP redirects to HTTPS, HTTPS `/api/health` returns 200 on all three hosts, and the landing, customer sign-in, staff sign-in, password-reset, and invitation routes load. Responses include CSP, `Referrer-Policy`, `X-Content-Type-Options: nosniff`, no-index and HSTS headers. Customer/staff reset pages use `no-referrer` and `no-store`; invitation pages use `no-store`. An unauthenticated session request with an untrusted `Origin` returned without an `Access-Control-Allow-Origin` header. Test requests carrying `X-Forwarded-For: 198.51.100.77, 203.0.113.55` returned 200 on customer and staff session endpoints, and neither sentinel appeared in its respective rate-limit table. The shorter initial name `gphk.asf.run` had no DNS A record.

The app's configured `GPHKM_TRUSTED_PROXY_CIDRS=172.29.3.1/32` matches the default Docker bridge gateway for the published web port. Still verify the actual Caddy-to-web peer address, two-client rate-limit attribution, and that the loopback web port is unreachable from an external client.

## Database and secrets

Store all secrets as runtime-only application variables. Generate separate random alphanumeric values for SERVICE_PASSWORD_POSTGRES, SERVICE_PASSWORD_MIGRATION, SERVICE_PASSWORD_RUNTIME, SERVICE_PASSWORD_MFAPROOF, SERVICE_PASSWORD_STRIPEWEBHOOK, and a stable 64-character SERVICE_PASSWORD_64_AUTH. Back up the auth secret privately before enrolling staff. Recovering from a database or key loss requires both the original database and matching auth secret. To rotate a database password on an existing volume, coordinate ALTER ROLE with the Coolify secret update.

The one-shot migrate service runs before web. It takes an advisory lock for migrations and seeds three fictional publications and one private supplier transactionally. The seed keeps staff edits across redeploys. The staging catalog uses reserved domains, a non-login audit actor and zero wallet credits. Check migration service logs after first deploy. No email worker, external supplier delivery, or private object storage is enabled for this demo.

Coolify image vulnerability scanning is enabled for this staging host with a 1 CPU and 1 GiB memory limit. The initial scan and the fresh-pull scan completed on 2026-11-21; the fresh-pull images reported 3 critical and 44 high findings, with no exploited findings. After PR #37, Coolify completed scans for the `web`, `migrate`, and `db` images tagged with `c9fa4e6e7b7ff2bc2bf9cd468c9c8f956fbb5bdc`. The application-level summary reported 35 problems (3 critical, 32 high, none exploited). The detailed findings include rows for `web` and `migrate` even where the resource status is `ok`; use the security summary, per-image status, and each finding's state together. The earlier `undici@6.28.0` and `brace-expansion@5.0.9` matches were in npm's global dependency tree as documented in npm's [bundled dependency report](https://github.com/npm/cli/issues/10111). The web server, migration and seed scripts, and health check invoke Node directly, so the final `web` and `migration` image stages remove the global npm package tree and its `npm`/`npx` links; npm remains in the dependency and build stages.

After PR #46 deployed commit `6f489167cf7fc478833b55323333ec54ba8b53c0`, Coolify reported the app healthy. The latest image scans completed at 12:18–12:19 UTC on 2026-11-21: `web` and `migrate` report `ok`; `db` remains `update_available`. The application summary reports 35 problems (3 critical, 32 high, none marked exploited). The exact current database image has 74 raw findings: 60 Go stdlib matches for Go 1.24.6 (3 critical, 32 high, 24 medium, 1 low), five `libcrypto3` findings, five `libssl3` findings, and four BusyBox/`golang.org/x/sys` findings. Keep these scanner findings open; do not suppress them based on package attribution alone.

The current PostgreSQL image contains the upstream `gosu 1.20` ARM64 privilege-dropping helper invoked by its entrypoint. Its reported Go 1.24.6 and `golang.org/x/sys` 0.1.0 metadata match the scanner inventory, and the deployed helper's SHA-256 `c216cb762520edb5ab0acb21cb9bc4bcc5f1544d365e8952a21514f04ea233ee` matches the signature-verified upstream release asset ([PostgreSQL Dockerfile](https://github.com/docker-library/postgres/blob/ac9627dcf544a8454f212a12ddeebfcdc0803d3e/17/alpine3.24/Dockerfile), [gosu 1.20 release](https://github.com/tianon/gosu/releases/tag/1.20)). This verifies the helper's identity but does not prove that all Go scanner findings originate from it.

Direct `govulncheck@v1.1.4 -mode=binary -show verbose` analysis of that exact binary with Go 1.24.6 reported zero vulnerabilities in its Symbol Results section, three package-level advisories, and 56 module-level advisories. Binary mode does not establish caller chains ([govulncheck documentation](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck)). Treat this as evidence about the analyzed binary only; it does not clear the broader Coolify findings, attribute every Go record to `gosu`, or address other packages. Keep the scanner findings open pending fuller image-level attribution and package review.

On 2026-11-21, pulling `postgres:17-alpine` on the ARM64 staging host returned digest `sha256:526f86d93c6ea08fd3f1fe5605650cacc781b2c6013169a0ad8f42c7d3d84f32`. Its installed OpenSSL packages (`libcrypto3` and `libssl3` 3.5.9-r0) and BusyBox 1.37.0-r31 match the running staging image. Coolify lists OpenSSL fixes at 3.5.9-r1, which is not yet in that tag; the four BusyBox/`x/sys` findings include no-fix records. Recheck the upstream tag on the next base refresh, rebuild through Coolify when upstream publishes a fixed package, and review no-fix findings separately. Do not change the PostgreSQL base to an unrelated version just to silence scanner counts.

The Compose services set `build.pull: true` to refresh their existing Dockerfile `FROM` images on each build, as defined by the [Compose Build Specification](https://docs.docker.com/reference/compose-file/build/#pull). The Node 24 stages now use the official `node:24-trixie-slim` line. For each base refresh, record the base-image digests resolved in Coolify's BuildKit logs and compare each with the matching registry digest for `postgres:17-alpine` or the Node tag used by that deployment (the `c9fa4e6` build used `node:24-bookworm-slim`; builds after PR #39 use `node:24-trixie-slim`). Compare like-for-like digests: index to index or platform manifest to the matching platform manifest. Also record the three resulting image IDs and scan those images before changing or suppressing individual findings. The resolved base digests for the `c9fa4e6` and `64c60ad` deployments still need to be recorded because Coolify's connected deployment API does not expose BuildKit logs without `read:sensitive`. See [Coolify image scanning](https://coolify.io/docs/core/security/image-scanning).

The staging backup policy is local-only: PostgreSQL uses Coolify's persistent volume `7a5y6aqefk0sx9hvyfcgvvji_staging-postgres` and a daily volume backup at 20:00 UTC (02:00 Dhaka), with stack pause during capture and retention limits of seven copies/seven days on the same VM. The owner chose to leave staging without an off-host destination. A staging archive was present on 2026-11-21, passed `gzip -t`, and had SHA-256 `6ee001c6efe0c79ce65659e528cc8858decec7d73066c8e946cf98746e84948a`. Back up the matching `BETTER_AUTH_SECRET` separately and privately. Local copies do not protect against loss of the Coolify VM. The previously stated production target is retained local backups plus offsite R2/S3 copies without automatic expiry, as recorded in [ADR-0039](adr/ADR-0039-production-vm-database-backups.md); Legal/Finance must approve live-data retention and deletion treatment under L-09 before production backups are retained. That separate production setup is not implemented or verified here.

Coolify's [storage backup](https://coolify.io/docs/core/persistent-storage/storage-mounts/backups) creates a file-level `.tar.gz` archive and does not restore it from the storage backup page. A staging restore rehearsal completed on 2026-11-21: the archive was extracted with numeric ownership into a new temporary Docker volume and started with the same PostgreSQL 17.12 image, in a `--network none` container with no public port. PostgreSQL became ready; database `gphkm_staging` opened and reported 100 public tables, 92 with row-level security. Read-only checks found the staging seed marker and all three expected reserved demo listing URLs. The temporary container and volume were removed. The live `staging-postgres` volume was not mounted or changed. This confirms PostgreSQL startup and representative restored staging data, not every stored row or application/session recovery; no app copy or external provider was involved. Repeat this rehearsal before production and verify migrations/seed records as part of the production recovery plan.

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
