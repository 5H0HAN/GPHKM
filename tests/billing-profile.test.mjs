import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBillingProfile } from "../src/modules/identity/billing-profile.ts";

test("billing profile trims optional values and normalizes email", () => {
  assert.deepEqual(normalizeBillingProfile({
    legalName: " Example LLC ", billingEmail: " Billing@Example.com ", billingAddress: " 123 Main Street, Anytown, US ",
  }), {
    legalName: "Example LLC", billingEmail: "billing@example.com", billingAddress: "123 Main Street, Anytown, US",
  });
  assert.deepEqual(normalizeBillingProfile({ legalName: "", billingEmail: "", billingAddress: "" }), {
    legalName: null, billingEmail: null, billingAddress: null,
  });
});

test("billing profile rejects invalid email, control characters, and oversized values", () => {
  assert.throws(() => normalizeBillingProfile({ legalName: "Company", billingEmail: "bad", billingAddress: "" }));
  assert.throws(() => normalizeBillingProfile({ legalName: "Bad\nName", billingEmail: "", billingAddress: "" }));
  assert.throws(() => normalizeBillingProfile({ legalName: "", billingEmail: "", billingAddress: "x".repeat(1001) }));
});
