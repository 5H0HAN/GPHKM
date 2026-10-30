# ADR-0020: Evidence resolution for ambiguous Stripe Checkout Session creation

**Status:** Accepted

## Context

Stripe Checkout Session creation can time out after Stripe received the request but before GPHKM received or persisted the Session ID. Retrying the same idempotency key is safe only within Stripe's idempotency retention window. Once that window closes, creating another Session risks duplicate customer charges. Leaving every such attempt open forever also blocks the organization's next wallet top-up.

## Decision

Finance or Super Admin may close an ambiguous attempt as failed only after at least 24 hours, when no Checkout Session ID, PaymentIntent ID, or linked provider event is recorded, and after the operator checks Stripe for both a Session and any payment. The operator must record an evidence reference and reason. PostgreSQL rechecks eligibility while locking the organization before the attempt, appends an audit event, and changes only the payment attempt state. It never credits or debits the wallet. Attempts with any linked provider event remain in normal event reconciliation.

## Consequences

- The open-top-up guard can be released after a documented provider-side absence check.
- Finance staff cannot use a timeout, missing webhook, or customer redirect as evidence.
- A completed or potentially paid Session cannot be closed through this command.
- This action does not resolve or bypass an existing Stripe-loss restriction.
