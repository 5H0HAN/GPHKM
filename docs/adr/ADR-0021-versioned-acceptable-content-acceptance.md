# ADR-0021: Require versioned acceptable-content acceptance at checkout

**Status:** Accepted
**Date:** 2026-10-29

## Context

Customers must accept platform-wide content rules and confirm they have rights to submit their articles and destination links. The acceptance must be attributable to the order and must not depend on a browser-only checkbox. Historical orders predate this requirement and must not be represented as accepted retroactively.

## Decision

Show the platform policy during checkout and require the ordering Member to affirm rights and acceptance before placing the order. Store the fixed policy version and server-generated acceptance timestamp on the order. Include acceptance in the idempotency request digest. PostgreSQL RLS permits new runtime order inserts only with the current version and a non-null timestamp, and the paid-order snapshot guard makes these fields immutable. Existing historical rows may keep both fields null and are not backfilled.

The draft v1 wording and staff review reason categories are specified in the Product Specification and checkout UI. They remain subject to the L-08 qualified legal review before listings are sold.

## Consequences

Changing policy wording requires a new version and a matching database/application update. An order cannot be created by a supported runtime path without acceptance. Acceptance evidence is attached to the organization order and is not exposed in customer API projections or supplier packets.
