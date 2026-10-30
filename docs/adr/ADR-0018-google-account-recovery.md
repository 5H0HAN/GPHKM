# ADR-0018: Rely on Google account recovery for customers

**Status:** Accepted
**Date:** 2026-10-29

## Context

Customer production authentication uses verified Google sign-in. A GPHKM-managed recovery flow would require a separate identity-proofing and support process, which is not defined for v1.

## Decision

Customers use Google account recovery. GPHKM does not provide customer password reset, provider-change recovery, or support-managed identity recovery in v1. Email/password remains limited to local test fixtures.

## Consequences

There is no GPHKM recovery email flow or support override that can grant account access. Customer-facing sign-in copy must direct customers to recover their Google account through Google. Any later GPHKM recovery feature requires a separate approved identity-proofing and audit design.
