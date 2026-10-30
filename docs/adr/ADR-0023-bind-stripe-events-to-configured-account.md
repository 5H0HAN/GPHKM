# ADR-0023: Bind Stripe webhook events to the configured API account

**Status:** Accepted
**Date:** 2026-10-29

## Context

Signature verification proves an event was signed with the configured webhook secret, while mode verification only distinguishes test from live. If the webhook secret and Stripe API key belong to different merchants, mode alone does not bind wallet settlement to the intended account.

## Decision

For every handled webhook, verify the raw-body signature, then retrieve that event ID with the same configured Stripe API client used by GPHKM. Compare event ID, type, livemode, creation timestamp, and underlying object ID before passing facts to the isolated database command. Reject any event with connected-account context because GPHKM does not use Connect. Make no database writes when retrieval fails or identities differ; keep the provider lookup outside database transactions.

## Consequences

The webhook secret and API key must resolve to the same Stripe account for settlement to proceed. A transient Stripe lookup error returns a retryable failure; persistent mismatches require Finance reconciliation. This check does not clear L-02 or enable live checkout; merchant configuration, legal review, provider certification, and other launch gates remain required.
