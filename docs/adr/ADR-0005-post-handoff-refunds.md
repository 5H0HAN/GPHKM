# ADR-0005: No post-handoff cancellation or refund by default

- **Status:** Accepted
- **Date:** 2026-10-27
- **Decision owners:** Product / Operations / Finance

## Context

After a supplier packet is handed off, the supplier may have started or completed work. A routine customer cancellation or automatic wallet refund could leave GPHKM paying for work already performed.

## Decision

Before the applicable cutoff, a customer may request cancellation under the item policy; see [ADR-0008](ADR-0008-item-cancellation-and-refunds.md) for the exact supplier/internal fulfillment cutoffs and writing-stage credits. After supplier handoff, customer cancellation and refund are not allowed by default.

Admin staff handling the Support case may investigate a documented break-glass exception and attempt supplier withdrawal where possible. Admin staff handling the Support case gather the facts and evidence. Finance or Super Admin may approve an item-specific wallet refund after reviewing that case; approval is not guaranteed. Legal or processor-required exceptions may require a different remedy. A wallet refund does not mean a refund to the original payment method. Keep original handoff packet and evidence immutable.

Supplier rejection, nonresponse, or inability to fulfill after handoff also receives Admin staff review through the Support case; it does not automatically create a refund. Staff may offer an equivalent only with customer approval. If no acceptable equivalent meets purchased terms, Admin staff handling the Support case may refer an item-specific wallet refund for Finance or Super Admin approval. A completed publication follows the separate no-post-completion-remedy policy, subject to legal/processor exceptions.

The initial internal supplier-acknowledgement follow-up target is 72 hours after provider-confirmed delivery or staff-recorded manual handoff when no acknowledgement exists. This is an internal operating target, not a supplier SLA. Staff may set a different item next-update date and determine subsequent follow-up case by case.

## Consequences

- Order-item and packet history distinguish customer cancellation request, supplier failure, withdrawal request, approved wallet refund, and publication completion.
- Refund exceptions require support case reference, reason, evidence, approver, exact item/amount, and audit record.
- Other items in the parent order continue independently.
- The organization wallet ledger remains append-only; refunds are compensating wallet credits.

## Revisit trigger

Revisit if GPHKM offers a published post-handoff cancellation window, standard partial-refund schedule, or supplier-backed cancellation guarantee.
