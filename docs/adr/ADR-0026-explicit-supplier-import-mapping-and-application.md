# ADR-0026: Row-specific supplier import review and application

**Status:** Accepted
**Date:** 2026-10-31

## Context

Supplier inventory arrives in public Google Sheets and CSV/XLSX files with inconsistent headers, category names, and listing details. Supplier categories are not the GPHKM catalog taxonomy. A row can also be incomplete, ambiguous, or missing a staff-approved retail price. Browser-only price inputs disappear on refresh and cannot serve as reliable input to a later single-row or whole-batch apply command.

## Decision

- Keep each source category label unchanged in the private staged source values. Staff selects one or more GPHKM categories on each row; supplier-level and batch-level category mappings are not used.
- Store a proposed USD retail price in cents on the staged row when staff saves corrections. Apply commands read this persisted value on the server.
- Check each row's normalized website against current marketplace and supplier inventory, show matching listing and supplier details, and recheck for new conflicts during application. A same-supplier exact match may be revised after review; a different-supplier conflict requires a reasoned separate-offer decision or rejection.
- Allow a staff member to create one ready, priced row as a draft; select ready, priced rows on the visible page; or create all remaining drafts across the batch. Keep the single-row action visible while explaining what review or price is still needed.
- Whole-batch apply is enabled only when every unapplied/unrejected row is ready and every row has a saved retail price. Apply in bounded 50-row transactions; when a new duplicate or validation issue appears, retain committed drafts and stop for review.
- Imported listings are always created as unpublished drafts. Imports never set supplier source cost, change live status, or publish a listing. Source-cost imports remain excluded pending O-04.

## Consequences

Staff review makes the source-to-platform taxonomy decision visible and independent for every row. Proposed prices survive pagination and refresh, while listing creation remains server-validated and auditable. Website ownership conflicts remain visible before and during application. Whole-batch import can report partial progress when a new conflict appears; staff resumes after resolving remaining rows.
