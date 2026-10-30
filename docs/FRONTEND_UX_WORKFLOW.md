# Frontend UX workflow

Use this workflow for changes to the public site, customer workspace, and staff console. It keeps UX review evidence-based, keeps business rules out of presentation-only changes, and reuses the tools already configured for GPHKM.

## Existing setup

- **Design source:** [`DESIGN.md`](../DESIGN.md), [`PRODUCT.md`](../PRODUCT.md), and the relevant Impeccable surface brief in [`.impeccable/surfaces/`](../.impeccable/surfaces/).
- **Design guard:** the Impeccable detector hook is enabled in [`.impeccable/config.json`](../.impeccable/config.json). It scans changed UI files and reports mechanical design issues. Check it with `$impeccable hooks status` when the hook appears inactive.
- **Live browser:** use the available in-app browser/CUA for visual inspection. Use the installed `webapp-testing` Playwright skill when repeatable route checks or saved screenshot files are needed.
- **UI implementation:** the app currently uses Next.js, React, CSS Modules, and shared CSS tokens in [`src/app/globals.css`](../src/app/globals.css). Continue with those primitives unless a concrete gap justifies a component-library decision.

Do not rerun `impeccable init` for each task. It has already captured product context; update the product or design record only when an approved product or visual decision changes.

The current preference is **code-first** for existing screens: inspect the real route, agree on the smallest blueprint, implement, then verify in-browser. Use comp-first only when the user asks to approve a visual direction before implementation or when a new surface needs a genuinely different visual world.

## Phase 1 — Audit the rendered experience

Before editing, read `AGENTS.md`, [`PRODUCT.md`](../PRODUCT.md), [`DESIGN.md`](../DESIGN.md), and the relevant product, security, and RBAC docs. Inspect the target route in the running local app using the intended account role. Check the current design contract and nearby components before proposing a replacement.

Inspect the affected page at desktop and mobile widths. For a cross-surface change, include representative routes from each affected surface:

- Public: `/`
- Customer: `/customer`, `/customer/catalog`, `/customer/orders`, `/customer/wallet`, `/customer/support`, `/customer/settings`
- Staff: `/staff`, `/staff/catalog`, `/staff/suppliers`, `/staff/fulfillment`, `/staff/support`, plus the affected Finance or Control route

List the three most important UX problems with the route, role, viewport, and visible evidence. Separate functional errors from visual friction. Do not edit code during this phase. If a page is role-restricted, use the authorized local fixture for that role; do not hide a failed authorization check by changing the route guard.

For a focused technical quality scan, use `$impeccable audit <target>`. Reserve `$impeccable critique <target>` for a requested or substantial design review; it produces a separate heuristic assessment and requires current browser evidence.

## Phase 2 — Write a small implementation blueprint

For each accepted issue, state:

1. The user task and the friction to remove.
2. The specific component or route to change.
3. The responsive behavior and keyboard interaction.
4. The states to cover: normal, empty, loading, validation error, and success where applicable.
5. The product, permission, privacy, and money rules the change must preserve.
6. The smallest verification that proves the change works.

Reuse the current Geist typography, theme tokens, CSS Modules, and existing controls. Do not propose `DashboardMain.tsx`, Tailwind values, shadcn MCP tools, or other components that are not in this repository. Do not introduce shadcn, Puppeteer, or another component/browser dependency by default. Make a short ADR or dependency proposal first if a real requirement cannot be met with the current setup.

## Phase 3 — Implement without crossing business boundaries

Make the smallest UI change that solves the accepted issues. Keep labels and actions clear, maintain visible focus, use semantic controls, support reduced motion, and keep touch targets usable. Preserve existing server actions, hooks, authorization checks, form validation, and error handling unless the issue requires a behavior change.

Presentation changes must not weaken server-side authorization, RLS, customer-safe projections, idempotency, audit evidence, or payment/order invariants. Never expose supplier identity, source classification, source costs, margin, private staff notes, credentials, or payment payloads to customers. Never test real-money behavior or send supplier communications as part of a visual smoke check.

Keep customer-provided text escaped and bounded. Do not add file uploads or arbitrary URL fetching to customer-facing forms. Keep inventory imports and other untrusted inputs in their existing staged and validated flows.

## Phase 4 — Verify and record evidence

For changed UI code, run:

```sh
npm run lint
npm run typecheck
npm test
```

Run `npm run build` when the environment has valid build-time application origins. Local `http://*.localhost` origins are intentionally rejected by production-mode auth validation; supply temporary HTTPS build origins without editing or committing `.env` values.

In the browser, verify the changed route in dark and light themes and at desktop and narrow/mobile widths. Exercise safe navigation, disclosures, search/filter controls, validation, and non-financial state changes. Do not click an action that spends wallet funds, sends an external email, changes access, or irreversibly changes data unless that action is separately authorized and is necessary for the task.

When requesting an Impeccable finish review, save current full-viewport captures in `.impeccable/review/desktop.png` and `.impeccable/review/mobile.png`. Include a `user-<width>.png` capture when the user reported a specific viewport. Capture the actual changed surfaces rather than reusing stale screenshots. Use synthetic local data only; never capture real customer, supplier-contact, credential, or payment information. Keep review screenshots local and out of Git. A live screenshot shown in chat is useful visual evidence, but does not satisfy the finish reviewer’s required saved-file inputs.

The automatic Impeccable hook reports issues after UI edits. Review and fix real findings; do not silence them with broad ignore rules. If the automatic hook did not run, use the installed Impeccable detector once on the changed markup/source targets and record its result. Do not run duplicate detector passes in the same change cycle.

Update [`DESIGN.md`](../DESIGN.md) when the shared tokens or reusable visual rules change. Update the surface brief when a new surface or approved visual direction changes. Keep screenshots and review notes scoped to the changed work; do not claim every route was tested when only representative routes were inspected.

## Pull request checklist

- [ ] Issue, user role, route, and responsive states are clear.
- [ ] Product, RBAC, privacy, and money boundaries remain intact.
- [ ] Keyboard focus, labels, contrast, and mobile layout were reviewed.
- [ ] Lint, typecheck, tests, and the relevant build check pass.
- [ ] Screenshots show the current changed surfaces at desktop and mobile sizes.
- [ ] Any design-system or product-document updates match the shipped implementation.
