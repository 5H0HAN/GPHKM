# ADR-0028: Private object storage and durable cleanup

**Status:** Accepted
**Date:** 2026-11-02

Production private files use one private Cloudflare R2 bucket through its S3 API, with bucket-scoped server-side credentials, provider-managed encryption, and authenticated application downloads. PostgreSQL records upload intent and references; the restricted existing worker deletes unlinked or explicitly discarded objects with leases and retries, independently of Resend approval. Do not apply automatic expiration to linked files: retain them with their owning records until Legal/Finance sets the exact periods under L-09; before production, provision a separate-account private backup bucket with a daily copy, at least 30 days of recovery points, and a successful joint database/object restore drill.
