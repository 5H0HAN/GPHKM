# Threat Model

**Purpose:** Record proportionate v1 trust boundaries and abuse cases. Revisit when a new integration or data flow is added.

## 1. Assets

Customer credentials, sessions, organization memberships, wallet ledger, payment attempts, orders, articles/briefs, supplier contacts, source rates, imported inventory, listing terms, publication evidence, staff permissions, audit records, provider credentials, and database/storage secrets.

## 2. Trust boundaries

1. Browser to Next.js server: IDs, amounts, statuses, customer text, and redirects are untrusted. Files enter only through staff import/evidence workflows.
2. Customer organization to another organization: every record is tenant-scoped.
3. Customer to staff: supplier/source and financial data are private.
4. Application to Stripe: callbacks and network responses require verification and matching.
5. Application to imported spreadsheets/public Sheets: content is untrusted.
6. Application/worker to metric providers and private storage: credentials and data are restricted.
7. Staff action to supplier: only minimum fulfillment information is disclosed.

## 3. Main abuse cases and controls

| Threat | Impact | Minimum controls |
|---|---|---|
| Guess another organization's order/wallet/item ID | Cross-tenant data leak or spend | Active membership, organization-scoped query, RLS defense in depth, negative authorization tests |
| Extract supplier identity or source mode through catalog APIs | Commercial relationship disclosure | Unified customer projection; exclude supplier IDs, contacts, costs, import data, and internal notes |
| Bypass trial or paid access to enumerate listings/URLs | Unauthorized catalog access | Server-side org entitlement check; omit records/URLs from API, search, metadata, prefetch, export, analytics, and caches |
| Replay a settled payment event | Duplicate wallet credit or access grant | Signature verification, exact matching, durable inbox, unique credit/grant references, idempotent processing |
| Forge a payment redirect or alter amount/currency | Unbacked wallet funds | Redirect is status-only; server-side amount/currency/environment/account matching |
| Concurrent or replayed multi-item checkout | Duplicate order or overspend | Scoped idempotency, server recomputation, atomic order/debit, database balance constraints |
| Chargeback after wallet funds are spent | Financial loss and unsafe further spend | Linked dispute case, holds, linked grant suspension, spending restrictions, reconciliation |
| Spreadsheet formula/parser/archive abuse | Staff or data compromise | Bounded data-only parser, reject formulas and macro-enabled formats, never execute workbook content, formula-safe exports, isolated staging/review |
| SSRF through a staff-provided Sheets source | Internal service access, credential exposure, or server-side network abuse | Accept only validated Google Sheets IDs/URLs; call fixed Google endpoints; reject arbitrary hosts and unvalidated redirects; never fetch cell-provided URLs; enforce time/size limits |
| Malicious or oversized customer order text | Stored/reflected injection, email/PDF corruption, resource exhaustion, or unsafe downstream rendering | No customer upload endpoint; field-specific byte/character limits; validate structured fields; encode text at each output boundary; generate PDFs only from a reviewed packet snapshot; never interpret customer text as markup |
| Stale supplier row changes live price/status | Wrong offer or unfulfillable order | Staged diff, staff approval, immutable revision, protected retail/live fields |
| Admin URL verification reaches internal services | SSRF | Manual verification in v1; fixed-safe fetch design and egress control before automation |
| Compromised Admin changes price/source/handoff | Fraud, privacy breach | MFA, least privilege, scoped supplier access, audit, alerts |
| Admin accesses unassigned order content or evidence | Customer content disclosure | Item-level assignment checks on every read/download/send; audit assignment changes and sensitive reads; Super Admin access audited |
| Privileged user alters audit history | Concealed financial, access, or fulfillment action | Append-only audit writes; restricted runtime privileges; corrections as linked events; detect deletion/alteration at the database boundary |
| Wrong recipient or supplier assignment sends customer content externally | Confidentiality breach or fulfillment error | Snapshot assignment/contact; preview exact recipient and items; require item consent; audit overrides; never group across orders/organizations |
| Email header/HTML injection in article or instructions | Spoofed headers, unsafe rendering, or unintended links | Fixed sender/recipient fields; reject header control characters; encode untrusted content; disable remote content; do not fetch URLs |
| Email API timeout or concurrent send duplicates a supplier packet | Duplicate work or conflicting instructions | Persist versioned packet and attempt first; serialize sends; idempotency; mark unclear outcome unknown; reconcile before audited resend |
| Overbroad report or handoff leaks customer content | PII/content disclosure | Super Admin-only internal JSON reports; minimum-data assigned handoff; exact packet preview, content consent, separate permissions, and audit |
| Unknown cost shown as zero | Misleading gross-profit report | Explicit unknown/provisional state; audited cost confirmation and adjustments |
| Link disappears after valid completion | Customer disagreement about remedy | Disclose lifetime intent/no guarantee at listing and checkout; preserve original evidence; record later cause without promising replacement |

## 4. Deliberate v1 limits

- No arbitrary URL fetching or automated publication verification; staff verifies live URLs.
- No customer access before verified sign-in.
- Customer article, brief, and order supplements are text-only; no customer order file uploads or attachments in v1. Staff import/evidence files remain separate, access-controlled workflows.
- Staff evidence accepts only private `.eml` or PDF files with size limits and download-only delivery; an external antivirus service is not required under the current accepted file scope and parser controls.
- No supplier accounts, payout execution, customer cash-out, multi-currency flow, or internal supplier data in customer projections.
- No customer-facing SEO metric until current license/attribution/redistribution rights and cost are approved.
- No automated supplier email send until sender-domain verification, provider event verification, and unknown-outcome procedures are ready.
- No automated link replacement or post-completion refund promise. Pre-completion non-fulfillment still follows item cancellation/refund policy.
- No separate API service, Redis, or multiple worker lanes without demonstrated need.

## 5. Security acceptance

Before production, verify cross-tenant denial, source-field exclusion, role checks, RLS under restricted runtime roles, Stripe event replay safety, concurrent wallet spend safety, import staging, formula-safe report output, handoff minimization, audit/alert delivery, and backup restoration.
