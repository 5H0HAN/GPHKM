# ADR-0028: Private object storage and durable cleanup

**Status:** Accepted
**Date:** 2026-11-02

Production private files use an approved private object-storage provider with server-side credentials and authenticated application downloads. Provider, account, location, and recovery details are maintained in private operations records. PostgreSQL records upload intent and references; the restricted existing worker deletes unlinked or explicitly discarded objects with leases and retries, independently of Resend approval. Retain linked files only under the policy approved by Legal/Finance under L-09. Validate the recovery procedure before production.
