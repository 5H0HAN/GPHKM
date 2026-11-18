# Stripe sandbox wallet funding

This runbook describes local test setup for the GPHKM organization wallet. It does not authorize live charges. On 2026-11-19, a $50 USD sandbox Visa top-up completed using Stripe Checkout Elements. Stripe delivered `checkout.session.completed`, the webhook returned HTTP 200, and the disposable database recorded one settled attempt and exactly one $50 wallet ledger credit. Live payments remain disabled.

## Credentials and least privilege

Use the dedicated `GPHKM Staging` sandbox for local integration testing and keep it separate from Stripe live mode. If CI later makes Stripe API calls, give CI its own sandbox and key; the automated tests use synthetic inputs and do not need Stripe credentials. Payments in a Stripe sandbox do not move real funds. The app accepts `rk_test_` server keys and rejects unrestricted `sk_` keys.

Grant the key only the resource permissions used by the application:

| Stripe resource | Permission | Application use |
| --- | --- | --- |
| Checkout Sessions | Write | Create and retrieve the top-up Checkout Session. |
| Events | Read | Re-fetch the signed webhook event through the configured Stripe account. |
| Payment Intents | Read | Resolve payment-attempt metadata for non-Checkout payment events. |

The wallet key is named `GPHKM Staging Wallet Top-ups`. A separate `GPHKM Staging Stripe CLI Listener` key has only **Debugging Tools: Write** and is stored outside the repository in `~/.config/gphkm/stripe-cli-test-key` with mode `600` (parent directory mode `700`). Do not reuse either key for another purpose. The current wallet key does not grant Charges, Refunds, Disputes, Payouts, or Balance Transactions access; those Finance provider reads remain outside this wallet-funding setup. Leave Customers, Connect, refund-write, payout-write, and unused permissions set to None. Stripe's [restricted-key guide](https://docs.stripe.com/keys/restricted-api-keys) documents permission mapping and request-log review.

If Stripe offers an expiry choice when creating the key, do not schedule automatic expiry for this integration. The key can still be intentionally rotated or revoked by an authorized operator; “no scheduled expiry” does not make a credential permanent.

Keep these values in the private project `.env` (or a deployment secret store), never in source control, browser code, screenshots, or chat:

- `STRIPE_SECRET_KEY`: the sandbox restricted key (`rk_test_…`).
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`: its matching sandbox publishable key (`pk_test_…`).
- `STRIPE_WEBHOOK_SECRET`: the local Stripe CLI listener's `whsec_…` value.
- `STRIPE_WEBHOOK_DATABASE_URL`: the separately provisioned webhook database role URL.
- Keep `GPHKM_REAL_MONEY_ENABLED=false` and `GPHKM_LAUNCH_GATES_VERIFIED=false`.

Do not copy a Stripe secret key into `NEXT_PUBLIC_*`. Restart the app after changing the environment. If the app reports wallet funding unavailable, check that the API and publishable keys are both test mode and that the webhook secret and webhook database URL are present.

## Local webhook forwarding

There is no stable production domain yet, so do not register a permanent Dashboard webhook endpoint or use a temporary tunnel as one. For local development, Stripe CLI forwards snapshot events to the loopback app without registering an endpoint in the Dashboard. Use the dedicated listener key for the `GPHKM Staging` sandbox and forward only the event types handled by the app:

```sh
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,charge.dispute.created,charge.dispute.closed,charge.refunded --forward-to http://localhost:3000/api/payments/stripe/webhook
```

Before generating events, set the dedicated sandbox's default API version to the version pinned in `src/server/payments/stripe.ts` (`2026-10-28.endive` at the time this runbook was written). Without `--latest`, the CLI uses the account's default API version. Do not add `--latest`: it follows Stripe's rolling latest and can drift from the SDK pin even if the code has not changed. When intentionally updating the SDK pin, update the sandbox default and any Dashboard endpoint version together. Copy the `whsec_…` value printed by the listener into the local `.env` as `STRIPE_WEBHOOK_SECRET`, then restart the app. The CLI listener secret is separate from any Dashboard endpoint secret; Stripe documents that it stays the same across CLI listener restarts. Do not use `--live`. The app handles the snapshot event types listed above and checks the signature against the exact request body.

When the customer domain is finalized, register a separate HTTPS endpoint in the GPHKM sandbox and production Stripe account. Subscribe only to the seven event types listed above, use snapshot events, and set the endpoint API version to the version pinned in `src/server/payments/stripe.ts` (`2026-10-28.endive` at the time this runbook was written). Store each endpoint's signing secret separately. Do not schedule endpoint-secret rotation; an authorized operator can still rotate or revoke a secret, so treat that as an intentional config change and update the matching environment before retiring the old secret. Stripe confirms the local CLI listener secret remains stable across `listen` restarts in its [CLI documentation](https://docs.stripe.com/cli/listen).

## Wallet top-up check

Use a dedicated disposable local database such as `gphkm_stripe_check` and a synthetic customer account that is an Owner of a test organization. Do not run this check against customer data, the default `gphkm` development database, or any database whose ledger you need to preserve. The default Compose PostgreSQL volume persists across restarts; stopping or restarting it does not make the database disposable. Create the scratch database inside local PostgreSQL with the migration/admin role, point all database URLs at that scratch database for the test, and drop only `gphkm_stripe_check` when the test is complete. Do not use `docker compose down -v` as routine test cleanup because that removes the persistent development volume. Follow the local setup sequence in the [README](../README.md#local-development): start PostgreSQL, provision its restricted roles, apply migrations, and create the local auth fixtures before starting the app. Set `CUSTOMER_APP_URL=http://localhost:3000`; the app uses that exact origin both to validate the top-up request and to build the Checkout return URL. `STRIPE_WEBHOOK_DATABASE_URL` must point to the separately provisioned webhook role, not the request runtime role.

1. Start the disposable Docker PostgreSQL database and the app with the sandbox-only values above. Confirm both real-money flags are `false` and the wallet recharge page is available only because matching test keys and webhook configuration are present.
2. As the test organization Owner, open **Wallet → Load balance** and start a USD top-up. Use `$50.00` if checking the current minimum top-up access grant as well as payment settlement.
3. Enter a contact email in Stripe's Contact Details Element. In the Payment Element, use the test Visa `4242 4242 4242 4242`, any future expiry such as `12/34`, any three-digit CVC, and synthetic test details. Stripe prohibits using real card details in test flows; its [testing guide](https://docs.stripe.com/testing) lists the supported test values.
4. Confirm the CLI forwards `checkout.session.completed` and the app returns the customer to the wallet. The redirect is not proof of payment: wait for the verified webhook, then refresh wallet history and confirm one matching top-up and exactly one ledger credit for the attempt.
5. Review safe application logs and the Stripe sandbox request logs for permission errors. The focused tests cover configuration, key mode, and provider-account binding. The database RLS smoke check also verifies that a late matching success cannot credit an already-settled attempt again; it does not simulate a real Stripe delivery. The 2026-11-19 sandbox check verified one `SETTLED` $50 attempt with one matching `PAYMENT_ATTEMPT` ledger credit; the earlier invalid `ui_mode` attempt was `FAILED` with no ledger entry.

The GPHKM wallet is an internal organization balance; it is distinct from card-network or device wallets. Additional payment methods displayed by Stripe depend on the sandbox and browser configuration. Test only methods explicitly enabled for the GPHKM sandbox.

## Local checks and boundaries

Run the deterministic Stripe tests without contacting Stripe:

```sh
node --conditions=react-server --test tests/stripe-wallet-topups.test.mjs
```

These tests validate configuration gates, restricted-key enforcement, bounded API retries, webhook mode/account checks, and Checkout Elements configuration using synthetic inputs. For the database ledger check, use an isolated, fully migrated local database and run `npm run db:check-rls:local`; this script rolls back its synthetic data. That check does not make a Stripe payment. A successful $50 sandbox top-up and verified webhook were also exercised on 2026-11-19 against a disposable database.

Never use a real card, a live API key, a live webhook secret, or a production database for these checks. Do not turn on either real-money flag. A successful redirect alone must never be recorded as a wallet credit; only the verified provider event can settle the immutable ledger entry.
