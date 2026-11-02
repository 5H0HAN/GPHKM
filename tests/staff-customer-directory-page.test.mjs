import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("customer directory exposes a clear manage action without changing its read boundary", () => {
  const page = source("../src/app/staff/(console)/customers/page.tsx");
  assert.match(page, /requireStaffAccess\(requestHeaders, "customer\.directory\.read"\)/);
  assert.match(page, /<span role="columnheader">Actions<\/span>/);
  assert.match(page, /className=\{styles\.manageLink\} href=\{customerHref\(row\.customer_id\)\} aria-label=\{`Manage customer/);
  assert.equal((page.match(/customerHref\(row\.customer_id\)/g) ?? []).length, 2);
  assert.match(page, /encodeURIComponent\(customerId\)/);
});

test("customer detail provides direct links to the existing guarded access and membership forms", () => {
  const page = source("../src/app/staff/(console)/customers/[customerId]/page.tsx");
  const actions = source("../src/app/staff/(console)/customers/actions.ts");
  const service = source("../src/server/identity/staff-customer-directory.ts");
  assert.match(page, /requireStaffAccess\(requestHeaders, "customer\.directory\.read"\)/);
  assert.match(page, /href="#account-access-heading">Manage account access/);
  assert.match(page, /href="#organization-memberships-heading">Manage organization memberships/);
  assert.match(page, /id="account-access-heading" tabIndex=\{-1\}/);
  assert.match(page, /id="organization-memberships-heading" tabIndex=\{-1\}/);
  assert.match(page, /action=\{setCustomerAccountStateAction\}/);
  assert.match(page, /action=\{updateCustomerMembershipAction\}/);
  assert.match(actions, /requireConfirmation\(form\)/);
  assert.match(service, /staffTx\(headers, "customer\.account\.manage"/);
});

test("customer actions remain reachable and labeled in the responsive directory layout", () => {
  const page = source("../src/app/staff/(console)/customers/page.tsx");
  const styles = source("../src/app/staff/(console)/customers/customers.module.css");
  for (const label of ["Customer", "Account", "Organizations", "Orders", "Open support", "Joined", "Actions"]) {
    assert.match(page, new RegExp(`<span className=\\{styles\\.cellLabel\\}>${label}<\\/span>`));
  }
  assert.match(styles, /\.manageLink \{[^}]*min-height:44px/);
  assert.match(styles, /\.customerActions a \{[^}]*min-height:44px/);
  assert.match(styles, /@media \(max-width:1200px\)[\s\S]*?\.listHeader \{ display:none; \}[\s\S]*?\.customerRow \.cellLabel \{ display:block/);
  assert.match(styles, /\.manageLink:focus-visible/);
});
