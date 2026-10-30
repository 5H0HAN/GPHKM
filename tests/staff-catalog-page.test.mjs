import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("staff catalog exposes real website links and announces listing action feedback", async () => {
  const page = await readFile(new URL("../src/app/staff/(console)/catalog/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/app/staff/(console)/catalog/catalog.module.css", import.meta.url), "utf8");
  assert.match(page, /item\.websiteUrl \? <a href=\{item\.websiteUrl\} target="_blank" rel="noopener noreferrer">/);
  assert.match(page, /Website URL not recorded/);
  assert.doesNotMatch(page, /item\.websiteUrl \?\? "#"/);
  assert.match(page, /query\.created && <p role="status"/);
  assert.match(page, /query\.updated && <p role="status"/);
  assert.match(page, /query\.error && <p role="alert"/);
  assert.match(styles, /\.button:focus-visible \{[^}]*outline:2px solid var\(--focus\)/);
  assert.doesNotMatch(styles, /\.button:focus-visible[^}]*outline:2px solid transparent/);
});
