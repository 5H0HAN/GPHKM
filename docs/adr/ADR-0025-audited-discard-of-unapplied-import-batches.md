# ADR-0025: Audited discard of unapplied import batches

- **Status:** Accepted
- **Date:** 2026-10-31
- **Decision owners:** Product, Engineering, Security

## Context

Staff need to remove a mistaken staged supplier import, including its private source snapshot. Any batch with an apply attempt or applied listing must remain available for reconciliation. Raw supplier data can include unmapped costs and other private fields, so deletion must use the same staff authorization and database boundary as other import commands.

## Options considered

- Keep all staged batches forever, which preserves review history but leaves mistaken uploads and private source snapshots retained indefinitely.
- Allow any batch to be deleted, which can erase evidence after listings were created or an apply attempt was recorded.
- Allow a reasoned, audited discard only before any apply event or applied listing exists, and retain all apply history.

## Decision

Admin and Super Admin may discard an import batch only when it has no apply events and no applied rows. The staff member must provide a reason and confirm the action. A database command locks and checks the batch, writes an immutable audit event, then removes its staged cost rows, staged rows, and batch record in one transaction. After commit, the application removes the corresponding private source snapshot. If file cleanup fails, the inaccessible object is logged for operational cleanup and the UI reports that condition. Batches with any apply event remain available for audit and reconciliation, even if no listing ultimately changed.

The staged batch itself and its source bytes are deleted. The audit record retains minimal provenance and integrity metadata: supplier, source type/reference, filename, byte count, content hash, creator, batch time/status, row and apply counts, and reason. It does not copy source cell values or the source object key.

## Consequences

- The UI can clean up a mistaken unapplied batch while keeping apply history immutable.
- Batch and row deletion is available only through the narrow database command; the request runtime does not gain direct import-table deletion rights.
- A private source object may require operational cleanup if storage deletion fails after the committed database deletion.
- O-02 still governs production object storage and its lifecycle. This decision does not set a general retention period for other imports or evidence.

## Revisit trigger

Revisit if staff need to undo an applied listing, retain a reversible soft-delete, or impose a legally required source-data retention period. Any undo must use a separate audited listing command and must not remove the original apply history.

## References

- [Product Specification](../PRODUCT_SPEC.md)
- [Open decisions](../OPEN_DECISIONS.md)
- [ADR-0006: Bounded staff imports](ADR-0006-text-only-order-input.md)
