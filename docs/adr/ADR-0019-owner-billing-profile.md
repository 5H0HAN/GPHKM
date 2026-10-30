# ADR-0019: Keep billing profiles minimal and Owner-only

**Status:** Accepted
**Date:** 2026-10-29

## Context

The customer organization area needs billing profile settings, but v1 does not generate invoices and should not collect unspecified financial or identity data.

## Decision

Store only optional legal name, billing email, and billing address. The organization Owner can view and update these values; Members, staff, suppliers, and reports cannot. The profile is not included in supplier packets. V1 does not collect tax identifiers or phone numbers and does not generate invoices.

Updates use a database-guarded command and append an audit event containing the organization, actor, timestamp, and changed field names, without storing field values in audit metadata. Retention and deletion follow the approved legal/finance schedule in L-09.

## Consequences

The fields may remain empty. If invoice generation or additional billing data becomes necessary, define its use, access, retention, and legal requirements before collecting more information.
