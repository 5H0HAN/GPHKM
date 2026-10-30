# ADR-0014: Keep wallet restrictions until Stripe loss is fully recovered

- **Status:** Accepted
- **Date:** 2026-10-29
- **Decision owner:** Project owner

## Context

A Stripe refund, reversal, or lost dispute can remove provider principal after some top-up funds have already been spent. Finance must post only a compensating wallet debit supported by available funds and must not make the wallet negative. A confirmed provider loss can therefore exceed the amount GPHKM can recover from the organization wallet.

## Decision

Finance records the current provider principal loss, cumulative wallet recovery, uncovered amount, evidence reference, and reason. If any provider loss remains uncovered, the reconciliation case remains open. The organization remains restricted from new wallet spending and new top-ups, and any remaining available wallet funds stay held. The normal resolution path cannot write off residual loss.

The case may close when a later verified provider snapshot shows the loss was reinstated or when the full principal loss has been recovered through the permitted wallet subledger. A verified dispute win may close its case through the webhook path only when all related disputes are won and no linked provider event remains unresolved.

The project owner confirmed that v1 will not add a recovery-only customer top-up or an off-platform repayment path. If no later wallet credit or verified provider reinstatement can cover the shortfall, the organization may remain restricted indefinitely.

## Consequences

- No customer can spend or add funds while the organization has an open Stripe reconciliation case.
- A partial Finance recovery is retained as an immutable ledger effect and decision; later resolutions apply only the additional net amount or a compensating credit if the provider reinstates funds.
- Residual exposure remains visible in Finance records and does not silently become a write-off.
- Some organizations may remain restricted indefinitely if Stripe does not reinstate funds and no later wallet credit covers the shortfall. A recovery-only top-up, off-platform repayment, or write-off policy requires a separate explicit decision.

## Enforcement

The database case state is the source of wallet restrictions. Finance resolution uses a current, complete Stripe snapshot, locked attempt and wallet rows, an immutable wallet ledger, append-only decision and audit records, and holds that cannot consume funds reserved for other cases. Runtime access to reconciliation tables is denied; narrow Finance-only functions perform reads and writes.
