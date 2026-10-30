# Authorization and RBAC Matrix

**Status:** Approved v1 authority baseline

## 1. Authority model

GPHKM has two separate authority domains:

- Customer membership grants access to one organization.
- Staff role grants access to internal catalog, fulfillment, finance, support, and reporting actions.

A customer role never implies staff access. A staff account's selected organization never grants customer access. Resolve current authority on every sensitive read and command. PostgreSQL RLS enforces tenant isolation as defense in depth; explicit application authorization and response allowlists remain required.

Verified customer signup creates an organization and its first Owner. A user may hold memberships in multiple organizations and must select an active organization context. Joining another organization requires an email invitation accepted by the same verified email. Invitations expire after seven days and default to Member. Owners may promote Members to co-Owners; the last Owner cannot leave or be removed before transferring ownership.

Organization closure is Support-managed in v1 and is not completed while active orders/disputes remain or the wallet balance is nonzero, except for a legally required exception. Closure does not create a voluntary cash-out.

## 2. Customer roles

| Capability | Organization Owner | Organization Member |
|---|---:|---:|
| View/edit own profile, security, sessions, and preferences | Yes | Yes |
| Browse catalog during trial or active paid grant | Yes | Yes |
| See a listing URL marked public while browsing is allowed | Yes | Yes |
| See hidden listing URLs with active organization access | Yes | Yes |
| View own orders and item progress | Yes | Yes |
| View all organization orders | Yes | No |
| View all organization Support cases | Yes | No |
| View/reply to own Support cases or cases tied to own orders | Yes | Yes |
| View organization wallet balance and sufficiency | Yes | Yes |
| View recharge/payment history | Yes | No |
| Fund the organization wallet | Yes | No |
| Place an order using available organization funds | Yes | Yes |
| Manage organization profile, billing, membership, and invitations | Yes | No |
| View supplier/source identity, internal costs, or staff notes | No | No |
| Grant staff access | No | No |

The Owner manages shared funding and settings. A Member may spend shared wallet funds by placing an order but cannot see recharge history. Both are subject to server-side access and purchase checks.

## 3. Staff roles

The v1 staff model uses three bundles: Admin, Finance, and Super Admin. Each ordinary staff account holds exactly one of Admin or Finance. Super Admin is the only all-access role. Admin handles routine catalog, fulfillment, and support work; there is no separate Support role in v1. Do not introduce a custom role builder. Public staff signup is disabled; the first Super Admin is bootstrapped by a one-time controlled setup, and Super Admin invites subsequent staff. MFA is required for staff; deactivation revokes active sessions.

| Action | Admin | Finance | Super Admin |
|---|---:|---:|---:|
| Manage catalog, pricing, listing visibility, and revisions | Yes | No | Yes |
| Manage supplier inventory, contacts, and staged imports | Yes | No | Yes |
| Trigger metric refresh and review results | Yes | No | Yes |
| View supplier costs and gross-profit reports | No by default | Yes | Yes |
| Handle routine fulfillment, supplier contact, and customer updates | Yes | No | Yes |
| Generate minimum-data handoff for assigned fulfillment | Yes, audited | No | Yes, audited |
| Record manual supplier paid/unpaid status with evidence | No | Yes | Yes |
| View wallet/provider reconciliation and dispute evidence | No | Yes | Yes |
| Approve policy-based pre-handoff item cancellation/refund | Yes, assigned item only | No | Yes |
| Approve post-handoff exception refund or policy override | No | Yes, after Support case/evidence review | Yes, after Support case/evidence review |
| Change global minimum/duration access policy | No | No | Yes, audited |
| Export internal supplier/performance JSON reports | No | No | Yes |
| Manage staff permissions | No | No | Yes |
| Read security/audit records | Scoped to own work | Finance scope | All authorized scope |
| Assign/reassign order-item fulfillment staff | Yes | No | Yes |

Super Admin has broad product access, but cannot bypass RLS, ledger invariants, required evidence, idempotency, approval rules, or audit. Super Admin actions are audited like all other privileged actions.

## 4. Export and handoff boundary

See the detailed packet lifecycle and reconciliation contract in [Supplier Email Handoff](SUPPLIER_HANDOFF.md).

- An internal JSON export is a report/data export and is Super Admin-only.
- An Admin may create the minimum-data fulfillment handoff for an assigned order item. Record actor, time, item, recipient/contact, and fields shared. Do not include customer name, account, or billing details.
- Admin or Super Admin assigns/reassigns fulfillment at the order-item level; assignment changes are audited. Only the currently assigned Admin may access that item's article, supplier packet, and manual handoff evidence. Super Admin access is audited.
- Assigned Admin may approve a pre-handoff cancellation/refund only when it follows the disclosed item and writing-stage policy; the system computes the wallet credit. Finance/Super Admin approval is required for post-handoff exceptions, policy overrides, and manual adjustments.
- Gross-profit reports and source-cost fields require Finance or Super Admin permission.
- Internal report exports exclude customer names, briefs/content, credentials, and provider payment payloads.
- Customer roles cannot export supplier data, internal classifications, source costs, or internal reports.

## 5. Separation and audit

- Finance or Super Admin may record a manually completed supplier payment. Require evidence/reference, amount, date, reason, actor, and timestamp.
- Do not allow any staff role to edit a wallet balance or posted ledger entry directly.
- High-risk refunds, manual corrections, and access-policy changes require reason codes and durable audit; add maker/checker approval where the financial policy requires it.
- Staff permission changes are audited; Super Admin cannot approve their own elevation.
- Recheck permission at mutation time. Session revocation and staff suspension take effect promptly.

## 6. Data visibility

| Data | Customer Owner/Member | Admin | Finance | Super Admin |
|---|---|---|---|---|
| Customer-safe live listing fields | Allowed by entitlement | Yes | As needed | Yes |
| Supplier identity and contacts | No | Yes for catalog/assigned fulfillment | No by default | Yes |
| Source rates and direct costs | No | No by default | Yes | Yes |
| Customer brief/article | Owner: all org orders; Member: own orders | Assigned fulfillment only | No by default | Only for authorized support/security need |
| Supplier packet content/recipient | No | Assigned fulfillment only | No | Authorized access, audited |
| Handoff transport/reconciliation metadata | No | Assigned fulfillment only | Reconciliation metadata only | Yes, audited |
| Support case and messages | Owner: all org cases; Member: cases they opened or tied to own orders | Assigned Admin for case/order | Finance-review fields only as needed | Yes, audited |
| Wallet ledger/recharge history | Owner only | No | Yes, scoped | Yes |
| Internal supplier performance | No | Operational measures | Financial measures as assigned | Yes |
| Internal JSON export | No | No | No | Yes |
| Payment payload/credentials | No | No | Restricted evidence only | Restricted, audited |

Use field-level allowlists. Access to a row or screen does not grant every field in the underlying record.

## 7. Enforcement requirements

- Customer query and mutation scope is derived from active membership, not caller-supplied organization ID alone.
- Staff commands resolve active staff authority and exact permission at action time.
- Apply RLS to organization-owned records using a trusted transaction-scoped tenant context and restricted runtime roles.
- Test customer/admin/finance/Super Admin boundaries, cross-organization denial, exports, and supplier handoffs under the actual runtime roles.
- Denials and sensitive reads/writes are auditable without logging private article content or provider secrets.
- Audit events are append-only for every role, including Super Admin. Corrections are new linked events; routine application roles cannot edit/delete earlier audit records.

## 8. Marketplace and policy access

Marketplace browse entitlement belongs to the organization. Owners and Members share its 15-day trial and paid grants. A public-URL flag bypasses URL concealment only while the organization is allowed to browse. Profile, settings, wallet, existing orders, and support remain reachable after access expiry.

Only Super Admin can change the audited global minimum/duration policy. The policy is versioned and applies to future grants. No manual access extension is part of v1; any future correction requires a separate approved policy and an audited command.
