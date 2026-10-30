# ADR-0006: Text-only customer order input and bounded staff imports

- **Status:** Accepted
- **Date:** 2026-10-28
- **Decision owners:** Product and security review

## Context

Customer articles, writing briefs, target URLs, anchor text, and publication instructions are needed for orders, but customer file attachments add an upload and malware-handling path. Staff still need CSV/XLSX inventory imports, and staff may attach private evidence to manual supplier handoffs. GPHKM also generates selectable-text PDFs from reviewed supplier packets.

## Decision

- Customer order details and supplements are plain-text fields only in v1. No customer order file upload or attachment endpoint is provided.
- Customer text is untrusted data: apply field-specific size/shape validation and context-aware output encoding; do not interpret it as HTML, scripts, templates, or executable markup.
- Staff CSV/XLSX imports use bounded, maintained, data-only parsing into isolated staging. Do not execute macros, formulas, embedded links, or external workbook references; reject formula cells and macro-enabled formats. Escape imported values in staff views and exports, including spreadsheet formula injection protection on exports.
- An external antivirus service is not required for v1. Revisit only if accepted file types, the threat model, provider/hosting requirements, or incident evidence materially change.
- Staff-only evidence uploads and GPHKM-generated supplier PDFs remain separate workflows with their own access, validation, and retention controls.

## Consequences

- The customer order flow does not need malware scanning, file quarantine, or customer attachment storage.
- Spreadsheet parsing still has a defined attack surface and must enforce file, archive expansion, row, worksheet, cell-size, and parsing-time limits.
- Orders can contain long articles, so text-size limits and safe rendering must be specified per field and enforced server-side.
- Adding customer file uploads later requires a new threat review and decision before implementation.

## References

- [Product Specification](../PRODUCT_SPEC.md)
- [Security Baseline](../SECURITY_BASELINE.md)
- [Threat Model](../THREAT_MODEL.md)
- [Supplier Email Handoff](../SUPPLIER_HANDOFF.md)
