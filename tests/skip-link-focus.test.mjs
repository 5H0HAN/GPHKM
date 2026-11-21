import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const targets = [
  ["public landing", "src/app/page.tsx", "main-content"],
  ["customer workspace", "src/app/customer/layout.tsx", "customer-main"],
  ["staff console", "src/app/staff/(console)/layout.tsx", "staff-main"],
];

test("skip links target programmatically focusable main content", async () => {
  for (const [label, file, id] of targets) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`href="#${id}"`), `${label} exposes a skip link`);
    assert.match(source, new RegExp(`id="${id}"[^>]*tabIndex=\\{-1\\}`), `${label} skip-link target can receive focus`);
  }
});
