import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
const resendWebhookUrl = process.env.RESEND_WEBHOOK_DATABASE_URL;
const roles = ["gphkm_runtime", "gphkm_worker", "gphkm_webhook", "gphkm_resend_webhook", "gphkm_mfa_proof"];
// Better Auth's global identity tables are not tenant-owned. Keep this exact
// exception list narrow; every other runtime-readable/writable public table
// must use RLS and must not be owned by the runtime role.
const authTablesWithoutRls = [
  "auth_account", "auth_rate_limit", "auth_session", "auth_staff_rate_limit",
  "auth_two_factor", "auth_user", "auth_verification",
];

function assertLocalDatabaseUrl(value: string | undefined, expectedUser: string): URL {
  if (!value) throw new Error("Local RLS check requires database URLs from .env");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Local RLS database URL is invalid"); }
  if (!(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      decodeURIComponent(url.username) !== expectedUser || url.pathname !== "/gphkm") {
    throw new Error("Local RLS check is restricted to the local GPHKM database");
  }
  return url;
}

function isPermissionDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "42501";
}

async function expectWriteDenied(client: Client, name: string, run: () => Promise<{ rowCount: number | null }>) {
  await client.query("SAVEPOINT rls_denied_write");
  try {
    const result = await run();
    assert.equal(result.rowCount, 0, `${name} unexpectedly changed a row`);
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT rls_denied_write");
    await client.query("RELEASE SAVEPOINT rls_denied_write");
  }
}

async function expectCheckConstraint(client: Client, name: string, run: () => Promise<unknown>) {
  await client.query("SAVEPOINT expected_constraint_failure");
  try {
    await run();
    assert.fail(`${name} unexpectedly succeeded`);
  } catch (error) {
    assert.equal(typeof error === "object" && error !== null && "code" in error ? error.code : null, "23514", `${name} must fail with a check-constraint violation`);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_constraint_failure");
    await client.query("RELEASE SAVEPOINT expected_constraint_failure");
  }
}

async function expectPermissionDenied(client: Client, name: string, run: () => Promise<unknown>) {
  await client.query("SAVEPOINT expected_permission_failure");
  try {
    await run();
    assert.fail(`${name} unexpectedly succeeded`);
  } catch (error) {
    assert.equal(typeof error === "object" && error !== null && "code" in error ? error.code : null, "42501", `${name} must be denied`);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_permission_failure");
    await client.query("RELEASE SAVEPOINT expected_permission_failure");
  }
}

async function expectUniqueViolation(client: Client, name: string, run: () => Promise<unknown>) {
  await client.query("SAVEPOINT expected_unique_failure");
  try {
    await run();
    assert.fail(`${name} unexpectedly succeeded`);
  } catch (error) {
    assert.equal(typeof error === "object" && error !== null && "code" in error ? error.code : null, "23505", `${name} must fail with a unique-constraint violation`);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_unique_failure");
    await client.query("RELEASE SAVEPOINT expected_unique_failure");
  }
}

assertLocalDatabaseUrl(databaseUrl, "gphkm_migration");
assertLocalDatabaseUrl(runtimeUrl, "gphkm_runtime");
assertLocalDatabaseUrl(resendWebhookUrl, "gphkm_resend_webhook");

const migration = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
const runtime = new Client({ connectionString: runtimeUrl, connectionTimeoutMillis: 5_000 });
const resendWebhook = new Client({ connectionString: resendWebhookUrl, connectionTimeoutMillis: 5_000 });
let transactionOpen = false;
let phase = "connecting to the local database";
try {
  await migration.connect();
  const connection = await migration.query<{ user: string; database: string }>(
    "select current_user as user, current_database() as database",
  );
  assert.equal(connection.rows[0]?.user, "gphkm_migration");
  assert.equal(connection.rows[0]?.database, "gphkm");

  phase = "checking restricted role attributes";
  const roleRows = await migration.query<{
    rolname: string; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean;
    rolinherit: boolean; rolbypassrls: boolean;
  }>(
    `select rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls
       from pg_roles where rolname = any($1::text[])`,
    [roles],
  );
  assert.equal(roleRows.rowCount, roles.length, "all five restricted application roles must exist");
  for (const role of roleRows.rows) {
    assert.deepEqual(
      [role.rolsuper, role.rolcreatedb, role.rolcreaterole, role.rolinherit, role.rolbypassrls],
      [false, false, false, false, false],
      `${role.rolname} must remain a restricted role`,
    );
  }
  const memberships = await migration.query(
    `select 1 from pg_auth_members membership
       join pg_roles member on member.oid = membership.member
      where member.rolname = any($1::text[]) limit 1`,
    [roles],
  );
  assert.equal(memberships.rowCount, 0, "application roles must not be members of other roles");

  phase = "checking isolated Resend webhook command grants";
  const webhookCommands = await migration.query<{ runtime_can_process_resend: boolean; resend_can_process_resend: boolean; resend_can_process_stripe: boolean; resend_can_attach_stripe: boolean }>(
    `select has_function_privilege('gphkm_runtime', 'public.gphkm_process_customer_notification_email_event(text,text,text,text,text,timestamptz)', 'EXECUTE') as runtime_can_process_resend,
            has_function_privilege('gphkm_resend_webhook', 'public.gphkm_process_customer_notification_email_event(text,text,text,text,text,timestamptz)', 'EXECUTE') as resend_can_process_resend,
            has_function_privilege('gphkm_resend_webhook', 'public.gphkm_process_stripe_event(text,text,text,text,text,text,text,numeric,text,text,timestamptz,text,text)', 'EXECUTE') as resend_can_process_stripe,
            has_function_privilege('gphkm_resend_webhook', 'public.gphkm_attach_stripe_event_facts(text,text,numeric,text,text)', 'EXECUTE') as resend_can_attach_stripe`,
  );
  assert.deepEqual(webhookCommands.rows[0], { runtime_can_process_resend: false, resend_can_process_resend: true, resend_can_process_stripe: false, resend_can_attach_stripe: false },
    "only the isolated Resend role may process Resend callbacks and it cannot call Stripe wallet commands");

  phase = "checking RLS coverage for all runtime-granted tables";
  const unprotected = await migration.query<{ relname: string }>(
    `select relation.relname
       from pg_class relation join pg_namespace schema on schema.oid = relation.relnamespace
      where schema.nspname = 'public' and relation.relkind in ('r','p')
        and (has_table_privilege('gphkm_runtime', relation.oid, 'SELECT')
          or has_table_privilege('gphkm_runtime', relation.oid, 'INSERT')
          or has_table_privilege('gphkm_runtime', relation.oid, 'UPDATE')
          or has_table_privilege('gphkm_runtime', relation.oid, 'DELETE'))
        and not relation.relrowsecurity
      order by relation.relname`,
  );
  assert.deepEqual(
    unprotected.rows.map((row) => row.relname), authTablesWithoutRls,
    "only the explicit global Better Auth identity tables may lack RLS among runtime-granted tables",
  );
  const runtimeOwned = await migration.query<{ relname: string }>(
    `select relation.relname
       from pg_class relation join pg_namespace schema on schema.oid = relation.relnamespace
      where schema.nspname = 'public' and relation.relkind in ('r','p')
        and pg_get_userbyid(relation.relowner) = 'gphkm_runtime'
      order by relation.relname`,
  );
  assert.deepEqual(runtimeOwned.rows, [], "the request runtime role must not own public tables");

  phase = "checking row-level security configuration";
  const rlsTables = await migration.query<{ relname: string; relrowsecurity: boolean }>(
    `select relation.relname, relation.relrowsecurity
       from pg_class relation join pg_namespace schema on schema.oid = relation.relnamespace
      where schema.nspname = 'public' and relation.relname = any($1::text[])`,
    [["organization", "organization_member", "wallet_account", "wallet_ledger_entry", "payment_attempt", "wallet_hold", "access_grant", "customer_order", "customer_order_item_milestone", "supplier_payment_record", "supplier_transfer_event", "supplier_transfer_allocation", "supplier_transfer_evidence"]],
  );
  assert.equal(rlsTables.rowCount, 13, "expected tenant, customer-history, and finance tables must exist");
  assert.ok(rlsTables.rows.every((table) => table.relrowsecurity), "tenant tables must have RLS enabled");

  phase = "checking supplier transfer permissions and uniqueness";
  const supplierTransferPrivileges = await migration.query<{ legacy_insert: boolean; transfer_insert: boolean; transfer_select: boolean; transfer_update: boolean; transfer_delete: boolean; allocation_insert: boolean; allocation_update: boolean; allocation_delete: boolean; evidence_insert: boolean; evidence_select: boolean; evidence_update: boolean; evidence_delete: boolean }>(
    `select has_table_privilege('gphkm_runtime', 'public.supplier_payment_record', 'INSERT') as legacy_insert,
            has_table_privilege('gphkm_runtime', 'public.supplier_transfer_event', 'INSERT') as transfer_insert,
            has_table_privilege('gphkm_runtime', 'public.supplier_transfer_event', 'SELECT') as transfer_select,
            has_table_privilege('gphkm_runtime', 'public.supplier_transfer_event', 'UPDATE') as transfer_update,
            has_table_privilege('gphkm_runtime', 'public.supplier_transfer_event', 'DELETE') as transfer_delete,
            has_table_privilege('gphkm_runtime', 'public.supplier_transfer_allocation', 'INSERT') as allocation_insert,
            has_table_privilege('gphkm_runtime', 'public.supplier_transfer_allocation', 'UPDATE') as allocation_update,
            has_table_privilege('gphkm_runtime', 'public.supplier_transfer_allocation', 'DELETE') as allocation_delete,
            has_table_privilege('gphkm_runtime', 'public.supplier_transfer_evidence', 'INSERT') as evidence_insert,
            has_table_privilege('gphkm_runtime', 'public.supplier_transfer_evidence', 'SELECT') as evidence_select,
            has_table_privilege('gphkm_runtime', 'public.supplier_transfer_evidence', 'UPDATE') as evidence_update,
            has_table_privilege('gphkm_runtime', 'public.supplier_transfer_evidence', 'DELETE') as evidence_delete`,
  );
  assert.deepEqual(supplierTransferPrivileges.rows[0], { legacy_insert: false, transfer_insert: true, transfer_select: true, transfer_update: false, transfer_delete: false, allocation_insert: true, allocation_update: false, allocation_delete: false, evidence_insert: true, evidence_select: true, evidence_update: false, evidence_delete: false },
    "runtime must not create legacy payment statuses or mutate transfer allocations/evidence; Finance inserts are RLS-protected");
  const milestonePrivileges = await migration.query<{ can_read: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }>(
    `select has_table_privilege('gphkm_runtime', 'public.customer_order_item_milestone', 'SELECT') as can_read,
            has_table_privilege('gphkm_runtime', 'public.customer_order_item_milestone', 'INSERT') as can_insert,
            has_table_privilege('gphkm_runtime', 'public.customer_order_item_milestone', 'UPDATE') as can_update,
            has_table_privilege('gphkm_runtime', 'public.customer_order_item_milestone', 'DELETE') as can_delete`,
  );
  assert.deepEqual(milestonePrivileges.rows[0], { can_read: true, can_insert: false, can_update: false, can_delete: false },
    "the request runtime may read scoped milestones but cannot forge or edit history");
  const transferReferenceIndex = await migration.query<{ indisunique: boolean }>(
    `select index_definition.indisunique
       from pg_index index_definition
       join pg_class index_relation on index_relation.oid = index_definition.indexrelid
      where index_relation.relname = 'supplier_transfer_supplier_reference_uq'`,
  );
  assert.equal(transferReferenceIndex.rows[0]?.indisunique, true, "supplier transfer references must be unique per supplier");
  const accessPolicyPrivileges = await migration.query<{ can_read: boolean; direct_update: boolean; command_execute: boolean }>(
    `select has_table_privilege('gphkm_runtime', 'public.access_policy', 'SELECT') as can_read,
            has_table_privilege('gphkm_runtime', 'public.access_policy', 'UPDATE') as direct_update,
            has_function_privilege('gphkm_runtime', 'public.gphkm_update_access_policy(numeric,text,integer,text)', 'EXECUTE') as command_execute`,
  );
  assert.deepEqual(accessPolicyPrivileges.rows[0], { can_read: true, direct_update: false, command_execute: true },
    "runtime reads the current policy but changes it only through the audited command");
  const billingProfilePrivileges = await migration.query<{ can_read: boolean; can_insert: boolean; can_update: boolean; command_execute: boolean }>(
    `select has_table_privilege('gphkm_runtime', 'public.organization_billing_profile', 'SELECT') as can_read,
            has_table_privilege('gphkm_runtime', 'public.organization_billing_profile', 'INSERT') as can_insert,
            has_table_privilege('gphkm_runtime', 'public.organization_billing_profile', 'UPDATE') as can_update,
            has_function_privilege('gphkm_runtime', 'public.gphkm_update_organization_billing_profile(text,text,text,text)', 'EXECUTE') as command_execute`,
  );
  assert.deepEqual(billingProfilePrivileges.rows[0], { can_read: true, can_insert: false, can_update: false, command_execute: true },
    "billing-profile reads are RLS-scoped and writes use the database command");
  const metricApprovalPrivileges = await migration.query<{ can_read: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean; sequence_usage: boolean; display_gate_execute: boolean }>(
    `select has_table_privilege('gphkm_runtime', 'public.listing_metric_approval_event', 'SELECT') as can_read,
            has_table_privilege('gphkm_runtime', 'public.listing_metric_approval_event', 'INSERT') as can_insert,
            has_table_privilege('gphkm_runtime', 'public.listing_metric_approval_event', 'UPDATE') as can_update,
            has_table_privilege('gphkm_runtime', 'public.listing_metric_approval_event', 'DELETE') as can_delete,
            has_sequence_privilege('gphkm_runtime', 'public.listing_metric_approval_event_event_sequence_seq', 'USAGE') as sequence_usage,
            has_function_privilege('gphkm_runtime', 'public.gphkm_metric_observation_customer_approved(text)', 'EXECUTE') as display_gate_execute`,
  );
  assert.deepEqual(metricApprovalPrivileges.rows[0], { can_read: true, can_insert: true, can_update: false, can_delete: false, sequence_usage: true, display_gate_execute: true },
    "metric approvals are append-only and customer projection is behind the legal gate");

  phase = "creating rollback-only synthetic tenants";
  const suffix = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const legalAcceptanceA = randomUUID();
  const legalAcceptanceB = randomUUID();
  const memberA = randomUUID();
  const adminA = randomUUID();
  const adminB = randomUUID();
  const financeA = randomUUID();
  const superAdminA = randomUUID();
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const ownerOrderA = randomUUID();
  const memberOrderA = randomUUID();
  const ownerOrderB = randomUUID();
  const cancellationOrder = randomUUID();
  const cancellationItem = randomUUID();
  const cancellationDebit = randomUUID();
  const cancellationRequest = randomUUID();
  const cancellationApprovalRequest = randomUUID();
  const ledgerA = randomUUID();
  const ledgerB = randomUUID();
  const attemptA = randomUUID();
  const attemptB = randomUUID();
  const disputedAttempt = randomUUID();
  const failedRefundAttempt = randomUUID();
  const partialRefundAttempt = randomUUID();
  const pendingRefundAttempt = randomUUID();
  const staleRefundAttempt = randomUUID();
  const openDisputeRefundAttempt = randomUUID();
  const incompleteRefundAttempt = randomUUID();
  const canceledRefundAttempt = randomUUID();
  const failedRefundLedger = randomUUID();
  const partialRefundLedger = randomUUID();
  const pendingRefundLedger = randomUUID();
  const staleRefundLedger = randomUUID();
  const openDisputeRefundLedger = randomUUID();
  const incompleteRefundLedger = randomUUID();
  const canceledRefundLedger = randomUUID();
  const failedRefundGrant = randomUUID();
  const partialRefundGrant = randomUUID();
  const pendingRefundGrant = randomUUID();
  const staleRefundGrant = randomUUID();
  const openDisputeRefundGrant = randomUUID();
  const incompleteRefundGrant = randomUUID();
  const canceledRefundGrant = randomUUID();
  const failedRefundHold = randomUUID();
  const partialRefundHold = randomUUID();
  const pendingRefundHold = randomUUID();
  const staleRefundHold = randomUUID();
  const openDisputeRefundHold = randomUUID();
  const incompleteRefundHold = randomUUID();
  const canceledRefundHold = randomUUID();
  const holdA = randomUUID();
  const holdB = randomUUID();
  const listingFixture = randomUUID();
  const checkoutListingFixture = randomUUID();
  const checkoutOrderFixture = randomUUID();
  const checkoutOrderItemFixture = randomUUID();
  const checkoutOrderItemFixtureTwo = randomUUID();
  const supplierFixture = randomUUID();
  const supplierOtherFixture = randomUUID();
  const orderItemFixture = randomUUID();
  const orderItemFixtureTwo = randomUUID();
  const orderItemFixtureThree = randomUUID();
  const transferFixture = randomUUID();
  const replacementTransferFixture = randomUUID();
  const transferAllocationFixture = randomUUID();
  const transferAllocationFixtureTwo = randomUUID();
  const transferEvidenceFixture = randomUUID();
  const replacementTransferAllocationFixture = randomUUID();
  const replacementTransferEvidenceFixture = randomUUID();
  const replacementCostFixture = randomUUID();
  const writingCostFixture = randomUUID();
  const nonWritingCostFixture = randomUUID();
  const originalEvidence = randomUUID();
  const correctionCase = randomUUID();
  const orderDebitA = randomUUID();
  const resendPacketId = `pkt_${randomUUID()}`;
  const resendPacketAttemptId = randomUUID();
  const manualPacketId = `pkt_${randomUUID()}`;
  const manualPacketAttemptId = randomUUID();
  await migration.query("BEGIN");
  transactionOpen = true;
  phase = "creating synthetic identities";
  await migration.query(
    `insert into auth_user (id, name, email, email_verified) values
       ($1, 'RLS Fixture Owner A', $2, true), ($3, 'RLS Fixture Owner B', $4, true),
       ($5, 'RLS Fixture Member A', $6, true), ($7, 'RLS Fixture Admin A', $8, true),
       ($9, 'RLS Fixture Admin B', $10, true), ($11, 'RLS Fixture Finance A', $12, true),
       ($13, 'RLS Fixture Super Admin', $14, true)`,
    [userA, `rls-owner-a-${suffix}@example.invalid`, userB, `rls-owner-b-${suffix}@example.invalid`,
      memberA, `rls-member-a-${suffix}@example.invalid`, adminA, `rls-admin-a-${suffix}@example.invalid`,
      adminB, `rls-admin-b-${suffix}@example.invalid`, financeA, `rls-finance-a-${suffix}@example.invalid`,
      superAdminA, `rls-super-admin-${suffix}@example.invalid`],
  );
  await migration.query(
    `insert into staff_account (user_id, role, active) values
       ($1, 'ADMIN', true), ($2, 'ADMIN', true), ($3, 'FINANCE', true), ($4, 'SUPER_ADMIN', true)`,
    [adminA, adminB, financeA, superAdminA],
  );
  phase = "checking audited Super Admin access policy command";
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true)", [superAdminA]);
  const currentPolicy = await migration.query<{ minimum_minor: string; duration: string; version: number }>(
    "select minimum_minor::text, duration, version from access_policy where id = 1",
  );
  const nextDuration = currentPolicy.rows[0]!.duration === "ONE_YEAR" ? "SIX_MONTHS" : "ONE_YEAR";
  const policyUpdate = await migration.query<{ minimum_minor: string; duration: string; version: number; changed: boolean }>(
    "select * from public.gphkm_update_access_policy($1::numeric, $2, $3, $4)",
    [currentPolicy.rows[0]!.minimum_minor, nextDuration, currentPolicy.rows[0]!.version, "RLS smoke policy update"],
  );
  assert.deepEqual(policyUpdate.rows[0], {
    minimum_minor: currentPolicy.rows[0]!.minimum_minor,
    duration: nextDuration,
    version: currentPolicy.rows[0]!.version + 1,
    changed: true,
  }, "Super Admin command updates the policy with a new version");
  const policyAudit = await migration.query<{ count: string }>(
    "select count(*)::text as count from audit_event where actor_user_id = $1 and action = 'ACCESS_POLICY_UPDATED' and target_id = '1'",
    [superAdminA],
  );
  assert.equal(policyAudit.rows[0]?.count, "1", "the update writes its audit event in the same transaction");
  await expectWriteDenied(migration, "direct access policy table update", () => migration.query(
    "update access_policy set version = version + 1 where id = 1",
  ));
  await migration.query("RESET ROLE");
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true)", [adminA]);
  await expectWriteDenied(migration, "Admin access policy command", () => migration.query(
    "select * from public.gphkm_update_access_policy(6000, 'SIX_MONTHS', $1, 'RLS smoke denied update')",
    [policyUpdate.rows[0]!.version],
  ));
  await migration.query("RESET ROLE");
  await migration.query(
    `insert into customer_legal_acceptance (id, user_id, actor_user_id, terms_version, privacy_version, terms_url, privacy_url) values
       ($1, $2, $2, 'rls-terms-a', 'rls-privacy-a', 'https://example.invalid/terms-a', 'https://example.invalid/privacy-a'),
       ($3, $4, $4, 'rls-terms-b', 'rls-privacy-b', 'https://example.invalid/terms-b', 'https://example.invalid/privacy-b')`,
    [legalAcceptanceA, userA, legalAcceptanceB, userB],
  );
  await migration.query(
    `insert into supplier (id, name, status, created_by_user_id) values ($1, 'RLS Fixture Supplier', 'ACTIVE', $2)`,
    [supplierFixture, adminA],
  );
  await migration.query(
    `insert into supplier (id, name, status, created_by_user_id) values ($1, 'RLS Other Supplier', 'ACTIVE', $2)`,
    [supplierOtherFixture, adminA],
  );
  phase = "checking supplier profile refund-count privacy boundary";
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true)", [adminA]);
  const operationalRefundCount = await migration.query<{ refunded: string }>(
    "select public.gphkm_supplier_operational_refunded_count($1, now() - interval '90 days')::text as refunded",
    [supplierFixture],
  );
  assert.equal(operationalRefundCount.rows[0]?.refunded, "0", "Admin may read only the aggregate operational refund count");
  await migration.query("select set_config('app.user_id', $1, true)", [financeA]);
  await migration.query("SAVEPOINT finance_refund_count_denied");
  try {
    await migration.query(
      "select public.gphkm_supplier_operational_refunded_count($1, now() - interval '90 days')",
      [supplierFixture],
    );
    assert.fail("Finance must not call the Admin-only supplier profile refund-count function");
  } catch (error) {
    assert.equal(typeof error === "object" && error !== null && "code" in error ? error.code : null, "42501",
      "Finance must be denied supplier operational refund counts");
  } finally {
    await migration.query("ROLLBACK TO SAVEPOINT finance_refund_count_denied");
    await migration.query("RELEASE SAVEPOINT finance_refund_count_denied");
  }
  await migration.query("RESET ROLE");
  phase = "creating synthetic organizations and memberships";
  await migration.query(
    `insert into organization (id, name, created_by) values
       ($1, 'RLS Fixture A', $2), ($3, 'RLS Fixture B', $4)`,
    [organizationA, userA, organizationB, userB],
  );
  await migration.query(
    `insert into organization_member (id, organization_id, user_id, role, active) values
       ($1, $2, $3, 'OWNER', true), ($4, $5, $6, 'OWNER', true),
       ($7, $2, $8, 'MEMBER', true), ($9, $5, $8, 'MEMBER', true)`,
    [randomUUID(), organizationA, userA, randomUUID(), organizationB, userB, randomUUID(), memberA, randomUUID()],
  );
  phase = "checking exclusive customer and staff identity domains";
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [userA, organizationA]);
  const ownSessions = await migration.query<{ id: string }>(
    "select id from auth_session where user_id = $1 and expires_at > now() order by created_at desc", [userA],
  );
  assert.deepEqual(ownSessions.rows, [], "restricted runtime can read the token-free session metadata projection");
  await expectCheckConstraint(migration, "staff principal added to customer organization", () => migration.query(
    "insert into organization_member (id, organization_id, user_id, role, active) values ($1, $2, $3, 'MEMBER', true)",
    [randomUUID(), organizationA, adminA],
  ));
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [superAdminA]);
  await expectCheckConstraint(migration, "customer principal provisioned as staff", () => migration.query(
    "insert into staff_account (user_id, role, active) values ($1, 'ADMIN', true)", [memberA],
  ));
  await migration.query("RESET ROLE");
  phase = "checking Owner-only organization billing profile";
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [userA, organizationA]);
  const billingChanged = await migration.query<{ changed: boolean }>(
    "select public.gphkm_update_organization_billing_profile($1, $2, $3, $4) as changed",
    [organizationA, "RLS Fixture Legal Org", "billing@fixture.invalid", "1 Synthetic Test Street"],
  );
  assert.equal(billingChanged.rows[0]?.changed, true, "Owner can save billing profile through the guarded command");
  const ownerBilling = await migration.query<{ legal_name: string; billing_email: string; billing_address: string }>(
    "select legal_name, billing_email, billing_address from organization_billing_profile where organization_id = $1", [organizationA],
  );
  assert.deepEqual(ownerBilling.rows[0], { legal_name: "RLS Fixture Legal Org", billing_email: "billing@fixture.invalid", billing_address: "1 Synthetic Test Street" });
  await migration.query("RESET ROLE");
  const billingAudit = await migration.query<{ count: string; no_pii: boolean }>(
    `select count(*)::text as count,
       bool_and(not (metadata ? 'legalName') and not (metadata ? 'billingEmail') and not (metadata ? 'billingAddress')) as no_pii
       from audit_event where organization_id = $1 and action = 'ORGANIZATION_BILLING_PROFILE_UPDATED'`, [organizationA],
  );
  assert.deepEqual(billingAudit.rows[0], { count: "1", no_pii: true }, "billing audit records field names but not private values");
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await expectWriteDenied(migration, "direct billing profile update", () => migration.query(
    "update organization_billing_profile set legal_name = 'Forged' where organization_id = $1", [organizationA],
  ));
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [memberA, organizationA]);
  const memberBilling = await migration.query("select * from organization_billing_profile where organization_id = $1", [organizationA]);
  assert.equal(memberBilling.rowCount, 0, "Member cannot read the billing profile");
  await expectWriteDenied(migration, "Member billing profile command", () => migration.query(
    "select public.gphkm_update_organization_billing_profile($1, 'Member Edit', null, null)", [organizationA],
  ));
  await migration.query("RESET ROLE");
  phase = "creating synthetic wallets and orders";
  await migration.query(
    `insert into wallet_account (organization_id, currency) values ($1, 'USD'), ($2, 'USD')`,
    [organizationA, organizationB],
  );

  await migration.query(
    `insert into wallet_ledger_entry (id, organization_id, actor_user_id, kind, delta_minor, currency, operation, idempotency_key)
     values ($1, $2, $3, 'TOP_UP', 5000, 'USD', 'RLS_SMOKE', $4), ($5, $6, $7, 'TOP_UP', 5000, 'USD', 'RLS_SMOKE', $8)`,
    [ledgerA, organizationA, userA, `ledger-a-${suffix}`, ledgerB, organizationB, userB, `ledger-b-${suffix}`],
  );
  await migration.query(
    `insert into customer_order (id, organization_id, actor_user_id, idempotency_key, request_hash,
       placement_total_minor, writing_total_minor, total_minor, content_sharing_notice_version,
       content_policy_version, content_policy_accepted_at) values
       ($1, $2, $3, $4, repeat('a', 64), 1000, 0, 1000, 'rls-smoke-v1', 'gphkm-content-policy-v1', now()),
       ($5, $2, $6, $7, repeat('b', 64), 1000, 0, 1000, 'rls-smoke-v1', 'gphkm-content-policy-v1', now()),
       ($8, $9, $10, $11, repeat('c', 64), 1000, 0, 1000, 'rls-smoke-v1', 'gphkm-content-policy-v1', now()),
       ($12, $9, $10, $13, repeat('d', 64), 1000, 500, 1500, 'rls-smoke-v1', 'gphkm-content-policy-v1', now())`,
    [ownerOrderA, organizationA, userA, `owner-a-${suffix}`, memberOrderA, memberA, `member-a-${suffix}`, ownerOrderB, organizationB, userB, `owner-b-${suffix}`, cancellationOrder, `cancel-${suffix}`],
  );
  phase = "requiring content-policy acceptance for runtime order creation";
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [userA, organizationA]);
  await expectWriteDenied(migration, "order creation without acceptable-content policy acceptance", () => migration.query(
    `insert into customer_order (id, organization_id, actor_user_id, idempotency_key, request_hash,
       placement_total_minor, writing_total_minor, total_minor, content_sharing_notice_version)
     values ($1, $2, $3, $4, repeat('d', 64), 1000, 0, 1000, 'rls-smoke-v1')`,
    [randomUUID(), organizationA, userA, `missing-policy-${suffix}`],
  ));
  await migration.query("RESET ROLE");
  await expectWriteDenied(migration, "order content-policy snapshot mutation", () => migration.query(
    "update customer_order set content_policy_version = null, content_policy_accepted_at = null where id = $1",
    [ownerOrderA],
  ));
  await migration.query(
    `insert into marketplace_listing (id, title, description, country_code, primary_language, categories,
       retail_price_cents, link_type, link_validity, turnaround_days, sponsored_content_marking)
     values ($1, 'RLS Fixture Listing', 'Synthetic rollback-only fixture', 'US', 'English', ARRAY['General'],
       1000, 'DOFOLLOW', 'PERMANENT', 30, true)`,
    [listingFixture],
  );
  phase = "checking supplier identity consistency on catalog listings";
  await expectCheckConstraint(migration, "supplier-sourced listing with different source and fulfillment suppliers", () =>
    migration.query(
      `insert into marketplace_listing_sourcing (listing_id, commercial_source, supplier_id, fulfillment_supplier_id, created_by_user_id)
       values ($1, 'SUPPLIER_SOURCED', $2, $3, $4)`,
      [listingFixture, supplierFixture, supplierOtherFixture, adminA],
    ),
  );
  await expectCheckConstraint(migration, "supplier-sourced listing without a fulfillment supplier", () =>
    migration.query(
      `insert into marketplace_listing_sourcing (listing_id, commercial_source, supplier_id, fulfillment_supplier_id, created_by_user_id)
       values ($1, 'SUPPLIER_SOURCED', $2, null, $3)`,
      [listingFixture, supplierFixture, adminA],
    ),
  );
  await migration.query(
    `insert into marketplace_listing_sourcing (listing_id, commercial_source, supplier_id, fulfillment_supplier_id, created_by_user_id)
     values ($1, 'SUPPLIER_SOURCED', $2, $2, $3)`,
    [listingFixture, supplierFixture, adminA],
  );
  await migration.query(
    "insert into marketplace_listing_url (listing_id, website_url) values ($1, 'https://blog.fixture.example/')",
    [listingFixture],
  );
  phase = "checking Super Admin metric redistribution attestation and customer gate";
  const metricObservation = randomUUID();
  const hostMetricObservation = randomUUID();
  const newerMetricObservation = randomUUID();
  const metricApproval = randomUUID();
  const hostMetricApproval = randomUUID();
  await migration.query(
    `insert into listing_metric_observation (id, listing_id, provider, value, status, observed_on, refreshed_at, source,
       metric_target, requested_target)
     values ($1, $2, 'OPEN_PAGE_RANK', 4.25, 'AVAILABLE', now(), now() - interval '1 minute', 'OpenPageRank API',
       'fixture.example', 'blog.fixture.example')`,
    [metricObservation, listingFixture],
  );
  await migration.query(
    `insert into listing_metric_observation (id, listing_id, provider, metric_scope, value, status, observed_on, refreshed_at, source,
       metric_target, requested_target)
     values ($1, $2, 'OPEN_PAGE_RANK', 'HOST', 8.5, 'AVAILABLE', now(), now(), 'OpenPageRank API',
       'blog.fixture.example', 'blog.fixture.example')`,
    [hostMetricObservation, listingFixture],
  );
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [superAdminA]);
  const metricApprovalResult = await migration.query<{ approved: boolean }>(
    "select public.gphkm_metric_observation_customer_approved($1) as approved", [metricObservation],
  );
  assert.equal(metricApprovalResult.rows[0]?.approved, false, "customer display gate is off until separately verified");
  await migration.query("RESET ROLE");
  await migration.query(
    `insert into audit_event (id, actor_user_id, action, target_type, target_id, correlation_id, reason_code, metadata)
     values ($1, $2, 'METRIC_REDISTRIBUTION_APPROVED', 'listing_metric_observation', $3, $4, 'RLS_SMOKE',
       jsonb_build_object('listingId', $5::text, 'provider', 'OPEN_PAGE_RANK', 'decision', 'APPROVED'))`,
    [randomUUID(), superAdminA, metricObservation, metricApproval, listingFixture],
  );
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [superAdminA]);
  await migration.query(
    `insert into listing_metric_approval_event (id, observation_id, listing_id, provider, decision, attribution_text,
       evidence_reference, reason, actor_user_id)
     values ($1, $2, $3, 'OPEN_PAGE_RANK', 'APPROVED', 'OpenPageRank metric; attribution approved for display',
       'https://openpagerank.com/terms', 'RLS smoke approval', $4)`,
    [metricApproval, metricObservation, listingFixture, superAdminA],
  );
  const approvedDisplayGate = await migration.query<{ approved: boolean }>(
    "select public.gphkm_metric_observation_customer_approved($1) as approved", [metricObservation],
  );
  assert.equal(approvedDisplayGate.rows[0]?.approved, false, "approval alone cannot bypass the external legal gate");
  await migration.query("select set_config('app.metric_customer_display_l05_verified', 'true', true)");
  const enabledDisplayGate = await migration.query<{ approved: boolean }>(
    "select public.gphkm_metric_observation_customer_approved($1) as approved", [metricObservation],
  );
  assert.equal(enabledDisplayGate.rows[0]?.approved, true, "current approved metric displays only when the external gate is explicitly enabled");
  await migration.query(
    `insert into audit_event (id, actor_user_id, action, target_type, target_id, correlation_id, reason_code, metadata)
     values ($1, $2, 'METRIC_REDISTRIBUTION_APPROVED', 'listing_metric_observation', $3, $4, 'RLS_SMOKE',
       jsonb_build_object('listingId', $5::text, 'provider', 'OPEN_PAGE_RANK', 'decision', 'APPROVED'))`,
    [randomUUID(), superAdminA, hostMetricObservation, hostMetricApproval, listingFixture],
  );
  await migration.query(
    `insert into listing_metric_approval_event (id, observation_id, listing_id, provider, decision, attribution_text,
       evidence_reference, reason, actor_user_id)
     values ($1, $2, $3, 'OPEN_PAGE_RANK', 'APPROVED', 'OpenPageRank host metric; attribution approved for display',
       'https://openpagerank.com/terms', 'RLS host metric scope smoke', $4)`,
    [hostMetricApproval, hostMetricObservation, listingFixture, superAdminA],
  );
  const enabledHostDisplayGate = await migration.query<{ approved: boolean }>(
    "select public.gphkm_metric_observation_customer_approved($1) as approved", [hostMetricObservation],
  );
  assert.equal(enabledHostDisplayGate.rows[0]?.approved, true, "host scope receives its own current, separately approved metric");

  await migration.query("RESET ROLE");
  await migration.query(
    `update marketplace_listing set status = 'LIVE', allows_sports_and_gaming = false,
       allows_pharmacy = false, allows_crypto = false, allows_foreign_language = false where id = $1`,
    [listingFixture],
  );
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true), set_config('app.metric_customer_display_l05_verified', 'true', true)",
    [userA, organizationA],
  );
  const customerMetrics = await migration.query<{ metric_scope: string; value: string }>(
    "select metric_scope, value::text from public.gphkm_latest_customer_listing_metrics($1, $2, $3)",
    [[listingFixture], userA, organizationA],
  );
  assert.deepEqual(customerMetrics.rows.map((row) => [row.metric_scope, row.value]).sort(), [
    ["HOST", "8.5000"], ["REGISTERED_DOMAIN", "4.2500"],
  ], "the customer projection preserves the distinct approved host and registered-domain scores");
  await migration.query("RESET ROLE");
  await migration.query(
    "update marketplace_listing_url set website_url = 'https://changed.fixture.example/' where listing_id = $1",
    [listingFixture],
  );
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true), set_config('app.metric_customer_display_l05_verified', 'true', true)",
    [userA, organizationA],
  );
  const changedTargetMetrics = await migration.query(
    "select * from public.gphkm_latest_customer_listing_metrics($1, $2, $3)",
    [[listingFixture], userA, organizationA],
  );
  assert.equal(changedTargetMetrics.rowCount, 0, "changing a listing URL invalidates approved observations for its former host");
  await migration.query("RESET ROLE");
  await migration.query(
    "update marketplace_listing_url set website_url = 'https://blog.fixture.example/' where listing_id = $1",
    [listingFixture],
  );
  phase = "checking trial and public-URL boundaries as gphkm_runtime";
  await migration.query(
    "update marketplace_listing_sourcing set url_visible_without_recharge = true where listing_id = $1",
    [listingFixture],
  );
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)",
    [userA, organizationA],
  );
  const trialAccess = await migration.query<{ active: boolean }>(
    "select created_at > now() - interval '15 days' as active from organization where id = $1", [organizationA],
  );
  assert.equal(trialAccess.rows[0]?.active, true, "a newly created organization receives its 15-day browsing trial");
  const trialPublicUrl = await migration.query<{ can_read: boolean }>(
    "select public.gphkm_customer_can_read_listing_url($1, $2, $3) as can_read",
    [listingFixture, organizationA, userA],
  );
  assert.equal(trialPublicUrl.rows[0]?.can_read, true, "a listing explicitly marked public may reveal its URL during an active trial");
  await migration.query("RESET ROLE");
  await migration.query(
    "update organization set created_at = now() - interval '16 days' where id = $1",
    [organizationB],
  );
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)",
    [userB, organizationB],
  );
  const expiredPaidAccess = await migration.query<{ active: boolean }>(
    "select public.gphkm_customer_has_marketplace_access($1) as active", [organizationB],
  );
  assert.equal(expiredPaidAccess.rows[0]?.active, false, "an organization without an active paid grant has no paid access");
  const expiredListings = await migration.query<{ id: string }>("select id from marketplace_listing where id = $1", [listingFixture]);
  assert.equal(expiredListings.rowCount, 0, "RLS hides catalog listings after trial expiry even when a listing URL is public");
  const expiredPublicUrl = await migration.query<{ website_url: string }>(
    "select website_url from marketplace_listing_url where listing_id = $1", [listingFixture],
  );
  assert.equal(expiredPublicUrl.rowCount, 0, "RLS hides public listing URLs after trial expiry");
  await migration.query("RESET ROLE");
  await migration.query("update organization set created_at = now() where id = $1", [organizationB]);
  await migration.query(
    "update marketplace_listing_sourcing set url_visible_without_recharge = false where listing_id = $1",
    [listingFixture],
  );
  phase = "preparing a second synthetic live listing for atomic multi-item checkout";
  await migration.query(
    `insert into marketplace_listing (id, title, description, country_code, primary_language, categories,
       retail_price_cents, link_type, link_validity, turnaround_days, allows_sports_and_gaming,
       allows_pharmacy, allows_crypto, allows_foreign_language, sponsored_content_marking)
     values ($1, 'Second RLS Checkout Listing', 'Synthetic rollback-only listing', 'US', 'English', ARRAY['General'],
       2000, 'NOFOLLOW', 'ONE_YEAR', 45, false, false, false, false, true)`,
    [checkoutListingFixture],
  );
  await migration.query(
    `insert into marketplace_listing_sourcing (listing_id, commercial_source, created_by_user_id)
     values ($1, 'PLATFORM_OWNED', $2)`,
    [checkoutListingFixture, adminA],
  );
  await migration.query(
    "insert into marketplace_listing_url (listing_id, website_url) values ($1, 'https://checkout.fixture.example/')",
    [checkoutListingFixture],
  );
  await migration.query(
    "update marketplace_listing set status = 'LIVE' where id = $1",
    [checkoutListingFixture],
  );

  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true)", [adminA]);
  const adminMetricApprovals = await migration.query("select * from listing_metric_approval_event");
  assert.equal(adminMetricApprovals.rowCount, 0, "ordinary Admin cannot read metric redistribution approval events");
  await expectWriteDenied(migration, "ordinary Admin metric redistribution approval", () => migration.query(
    `insert into listing_metric_approval_event (id, observation_id, listing_id, provider, decision, attribution_text,
       evidence_reference, reason, actor_user_id)
     values ($1, $2, $3, 'OPEN_PAGE_RANK', 'APPROVED', 'Unauthorized attribution',
       'https://openpagerank.com/terms', 'Admin should be denied', $4)`,
    [randomUUID(), metricObservation, listingFixture, adminA],
  ));
  await migration.query("RESET ROLE");
  await migration.query(
    `insert into listing_metric_observation (id, listing_id, provider, value, status, observed_on, refreshed_at, source,
       metric_target, requested_target)
     values ($1, $2, 'OPEN_PAGE_RANK', 4.5, 'AVAILABLE', now(), now() + interval '1 minute', 'OpenPageRank API',
       'fixture.example', 'blog.fixture.example')`,
    [newerMetricObservation, listingFixture],
  );
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [superAdminA]);
  const staleApprovalGate = await migration.query<{ approved: boolean }>(
    "select public.gphkm_metric_observation_customer_approved($1) as approved", [metricObservation],
  );
  assert.equal(staleApprovalGate.rows[0]?.approved, false, "a newer metric refresh invalidates the older attestation");
  await migration.query("RESET ROLE");
  phase = "checking synthetic order accepts item";
  const pendingFixtureOrder = await migration.query<{ checkout_state: string; customer_status: string }>(
    "select checkout_state, customer_status from customer_order where id = $1", [ownerOrderA],
  );
  assert.deepEqual(pendingFixtureOrder.rows[0], { checkout_state: "PENDING_POST", customer_status: "ORDER_RECEIVED" });
  phase = "creating synthetic order item";
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)",
    [userA, organizationA],
  );
  await migration.query(
    `insert into customer_order_item (id, order_id, listing_id, listing_revision, customer_listing_snapshot,
       placement_price_minor, writing_selected, target_url, anchor_text, article_text,
       supplier_sharing_consented, consent_notice_version)
     values ($1, $2, $3, 1, '{"title":"RLS Fixture Listing"}'::jsonb, 1000, false,
       'https://example.invalid/target', 'example', 'Synthetic rollback-only article', true, 'rls-smoke-v1')`,
    [orderItemFixture, ownerOrderA, listingFixture],
  );
  await migration.query("RESET ROLE");
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)",
    [userB, organizationB],
  );
  await migration.query(
    `insert into customer_order_item (id, order_id, listing_id, listing_revision, customer_listing_snapshot,
       placement_price_minor, writing_price_minor, writing_selected, target_url, anchor_text, article_text, writing_brief,
       supplier_sharing_consented, consent_notice_version)
     values ($1, $2, $3, 1, '{"title":"RLS Fixture Listing"}'::jsonb, 1000, 0, true,
       'https://example.invalid/target-two', 'example', null, 'Synthetic rollback-only writing brief', true, 'rls-smoke-v1')`,
    [orderItemFixtureTwo, ownerOrderB, listingFixture],
  );
  await migration.query(
    `insert into customer_order_item (id, order_id, listing_id, listing_revision, customer_listing_snapshot,
       placement_price_minor, writing_selected, writing_price_minor, writing_first_stage_minor, writing_final_stage_minor,
       target_url, anchor_text, writing_brief, supplier_sharing_consented, consent_notice_version)
     values ($1, $2, $3, 1, '{"title":"Cancellation Fixture Listing"}'::jsonb, 1000, true, 500, 300, 200,
       'https://example.invalid/cancellation', 'fixture cancellation', 'Synthetic refund stage fixture', true, 'rls-smoke-v1')`,
    [cancellationItem, cancellationOrder, listingFixture],
  );
  await migration.query("RESET ROLE");
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [userB, organizationB]);
  await migration.query("insert into order_item_writing (order_item_id) values ($1)", [cancellationItem]);
  await migration.query("RESET ROLE");
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)",
    [memberA, organizationA],
  );
  await migration.query(
    `insert into customer_order_item (id, order_id, listing_id, listing_revision, customer_listing_snapshot,
       placement_price_minor, writing_selected, target_url, anchor_text, article_text,
       supplier_sharing_consented, consent_notice_version)
     values ($1, $2, $3, 1, '{"title":"RLS Fixture Listing"}'::jsonb, 1000, false,
       'https://example.invalid/target-three', 'example', 'Third synthetic rollback-only article', true, 'rls-smoke-v1')`,
    [orderItemFixtureThree, memberOrderA, listingFixture],
  );
  await migration.query("RESET ROLE");
  phase = "exercising atomic multi-item checkout through the restricted runtime role";
  const listingSnapshotRows = await migration.query<{ id: string; snapshot: Record<string, unknown> }>(
    `select l.id, jsonb_build_object(
       'listingId', l.id, 'revision', l.revision, 'title', l.title, 'description', l.description,
       'countryCode', l.country_code, 'primaryLanguage', l.primary_language, 'categories', l.categories,
       'retailPriceCents', l.retail_price_cents, 'linkType', l.link_type, 'linkValidity', l.link_validity,
       'turnaroundDays', l.turnaround_days, 'allowsSportsAndGaming', l.allows_sports_and_gaming,
       'allowsPharmacy', l.allows_pharmacy, 'allowsCrypto', l.allows_crypto,
       'allowsForeignLanguage', l.allows_foreign_language, 'sponsoredContentMarking', l.sponsored_content_marking,
       'writingEnabled', l.writing_enabled, 'writingPriceCents', l.writing_price_cents,
       'writingTurnaroundDays', l.writing_turnaround_days, 'writingFirstDraftCents', l.writing_first_draft_cents,
       'writingFinalDraftCents', l.writing_final_draft_cents, 'buyerRequirements', l.buyer_requirements
     ) as snapshot from marketplace_listing l where l.id = any($1::text[]) order by l.id`,
    [[listingFixture, checkoutListingFixture]],
  );
  assert.equal(listingSnapshotRows.rowCount, 2, "both synthetic checkout listings must be available");
  const snapshotByListing = new Map(listingSnapshotRows.rows.map((row) => [row.id, row.snapshot]));
  const checkoutOrderKey = `checkout-${suffix}`;
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)",
    [userA, organizationA],
  );
  await migration.query(
    `insert into customer_order (id, organization_id, actor_user_id, idempotency_key, request_hash,
       placement_total_minor, writing_total_minor, total_minor, content_sharing_notice_version,
       content_policy_version, content_policy_accepted_at)
     values ($1, $2, $3, $4, repeat('e', 64), 3000, 0, 3000, 'rls-checkout-v1', 'gphkm-content-policy-v1', now())`,
    [checkoutOrderFixture, organizationA, userA, checkoutOrderKey],
  );
  await migration.query(
    `insert into customer_order_item (id, order_id, listing_id, listing_revision, customer_listing_snapshot,
       placement_price_minor, writing_selected, target_url, anchor_text, article_text,
       supplier_sharing_consented, consent_notice_version)
     values ($1, $2, $3, 1, $4::jsonb, 1000, false, 'https://customer.fixture.example/one', 'fixture one',
       'Synthetic rollback-only article one', true, 'rls-checkout-v1'),
       ($5, $2, $6, 1, $7::jsonb, 2000, false, 'https://customer.fixture.example/two', 'fixture two',
       'Synthetic rollback-only article two', true, 'rls-checkout-v1')`,
    [checkoutOrderItemFixture, checkoutOrderFixture, listingFixture, JSON.stringify(snapshotByListing.get(listingFixture)),
      checkoutOrderItemFixtureTwo, checkoutListingFixture, JSON.stringify(snapshotByListing.get(checkoutListingFixture))],
  );
  const checkoutResult = await migration.query<{ ledger_id: string }>(
    "select public.gphkm_finalize_order_checkout($1) as ledger_id", [checkoutOrderFixture],
  );
  const checkoutLedgerId = checkoutResult.rows[0]?.ledger_id;
  assert.ok(checkoutLedgerId, "multi-item checkout must return its wallet debit ledger id");
  const repeatedCheckout = await migration.query<{ ledger_id: string }>(
    "select public.gphkm_finalize_order_checkout($1) as ledger_id", [checkoutOrderFixture],
  );
  assert.equal(repeatedCheckout.rows[0]?.ledger_id, checkoutLedgerId, "a finalizer replay must return the original debit");
  const finalizedCheckout = await migration.query<{
    checkout_state: string; paid_ledger_entry_id: string; total_minor: string;
    balance_minor: string; debit_count: number; debit_minor: string;
  }>(
    `select o.checkout_state, o.paid_ledger_entry_id, o.total_minor::text,
       w.balance_minor::text as balance_minor,
       (select count(*)::int from wallet_ledger_entry e where e.operation = 'ORDER_CHECKOUT:' || $2
          and e.idempotency_key = $3) as debit_count,
       (select e.delta_minor::text from wallet_ledger_entry e where e.id = o.paid_ledger_entry_id) as debit_minor
     from customer_order o join wallet_account w on w.organization_id = o.organization_id where o.id = $1`,
    [checkoutOrderFixture, userA, checkoutOrderKey],
  );
  assert.deepEqual(finalizedCheckout.rows[0], {
    checkout_state: "PAID", paid_ledger_entry_id: checkoutLedgerId, total_minor: "3000",
    balance_minor: "2000", debit_count: 1, debit_minor: "-3000",
  }, "the whole two-item order must commit with one exact wallet debit and no duplicate on replay");
  await migration.query("RESET ROLE");
  await migration.query(
    `insert into wallet_ledger_entry (id, organization_id, actor_user_id, kind, delta_minor, currency,
       operation, idempotency_key, related_type, related_id, reason_code)
     values ($1, $2, $3, 'ORDER_DEBIT', -1000, 'USD', 'RLS_SMOKE_ORDER', $4, 'CUSTOMER_ORDER', $5, 'ORDER_CHECKOUT')`,
    [orderDebitA, organizationA, userA, `order-debit-${suffix}`, ownerOrderA],
  );
  phase = "finalizing synthetic order checkout";
  await migration.query(
    "update customer_order set checkout_state = 'PAID', paid_ledger_entry_id = $2 where id = $1",
    [ownerOrderA, orderDebitA],
  );
  await migration.query(
    `insert into wallet_ledger_entry (id, organization_id, actor_user_id, kind, delta_minor, currency,
       operation, idempotency_key, related_type, related_id, reason_code)
     values ($1, $2, $3, 'ORDER_DEBIT', -1500, 'USD', 'RLS_SMOKE_CANCELLATION', $4,
       'CUSTOMER_ORDER', $5, 'ORDER_CHECKOUT')`,
    [cancellationDebit, organizationB, userB, `cancel-debit-${suffix}`, cancellationOrder],
  );
  await migration.query(
    "update customer_order set checkout_state = 'PAID', paid_ledger_entry_id = $2 where id = $1",
    [cancellationOrder, cancellationDebit],
  );
  phase = "creating synthetic fulfillment financial snapshot";
  await migration.query(
    `insert into order_item_financial (order_item_id, commercial_source, supplier_id, fulfillment_supplier_id)
     values ($1, 'PLATFORM_OWNED', null, $2), ($3, 'PLATFORM_OWNED', null, $2), ($4, 'PLATFORM_OWNED', null, null)`,
    [orderItemFixture, supplierFixture, orderItemFixtureTwo, cancellationItem],
  );
  await migration.query("update order_item_fulfillment_supplier set supplier_id = $2 where order_item_id = $1", [orderItemFixtureTwo, supplierOtherFixture]);

  phase = "checking item-scoped fulfillment updates and assignment command";
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [adminB]);
  const columnPrivileges = await migration.query<{ lifecycle: boolean; assignment: boolean; listingTitle: boolean }>(
    `select has_column_privilege('gphkm_runtime', 'public.order_item_fulfillment', 'state', 'UPDATE') as lifecycle,
            has_column_privilege('gphkm_runtime', 'public.order_item_fulfillment', 'assigned_admin_id', 'UPDATE') as assignment,
            has_column_privilege('gphkm_runtime', 'public.order_item_fulfillment', 'listing_title', 'UPDATE') as "listingTitle"`,
  );
  assert.deepEqual(columnPrivileges.rows[0], { lifecycle: true, assignment: false, listingTitle: false },
    "runtime can update only the fulfillment lifecycle columns, never assignment or listing identity");
  const unassignedAdminUpdate = await migration.query(
    "update order_item_fulfillment set updated_at = now() where order_item_id = $1",
    [orderItemFixture],
  );
  assert.equal(unassignedAdminUpdate.rowCount, 0, "an unassigned Admin cannot update another Admin's fulfillment item");
  await expectWriteDenied(migration, "direct reassignment by an assigned Admin", () => migration.query(
    "update order_item_fulfillment set assigned_admin_id = $2 where order_item_id = $1",
    [orderItemFixture, adminB],
  ));
  const assignment = await migration.query<{ order_item_id: string }>(
    "select public.gphkm_assign_fulfillment_item($1, $2) as order_item_id",
    [orderItemFixture, adminB],
  );
  assert.equal(assignment.rows[0]?.order_item_id, orderItemFixture, "an active Admin may use the dedicated assignment command");
  await migration.query("select set_config('app.user_id', $1, true)", [superAdminA]);
  await expectCheckConstraint(migration, "deactivation with active assigned fulfillment work", () => migration.query(
    "select public.gphkm_deactivate_staff($1, 'RLS_TEST')", [adminB],
  ));
  await expectCheckConstraint(migration, "assignment to a Finance account", () => migration.query(
    "select public.gphkm_assign_fulfillment_item($1, $2)", [orderItemFixture, financeA],
  ));
  await migration.query("select set_config('app.user_id', $1, true)", [adminB]);
  await expectWriteDenied(migration, "assigned Admin cannot change fulfillment listing identity", () => migration.query(
    "update order_item_fulfillment set listing_title = 'tampered' where order_item_id = $1",
    [orderItemFixture],
  ));
  await expectWriteDenied(migration, "assigned Admin direct reassignment", () => migration.query(
    "update order_item_fulfillment set assigned_admin_id = $2 where order_item_id = $1",
    [orderItemFixture, adminA],
  ));
  await migration.query("select set_config('app.user_id', $1, true)", [adminA]);
  const previousAssigneeUpdate = await migration.query(
    "update order_item_fulfillment set updated_at = now() where order_item_id = $1",
    [orderItemFixture],
  );
  assert.equal(previousAssigneeUpdate.rowCount, 0, "reassignment immediately removes the former Admin's update access");
  await migration.query("select set_config('app.user_id', $1, true)", [financeA]);
  assert.equal((await migration.query("update order_item_fulfillment set updated_at = now() where order_item_id = $1", [orderItemFixture])).rowCount,
    0, "Finance cannot update fulfillment operational rows");
  await expectWriteDenied(migration, "Finance fulfillment assignment", () => migration.query(
    "select public.gphkm_assign_fulfillment_item($1, $2)", [orderItemFixture, adminA],
  ));
  await migration.query("select set_config('app.user_id', $1, true)", [superAdminA]);
  const superAdminAssignment = await migration.query<{ order_item_id: string }>(
    "select public.gphkm_assign_fulfillment_item($1, $2) as order_item_id",
    [orderItemFixture, adminA],
  );
  assert.equal(superAdminAssignment.rows[0]?.order_item_id, orderItemFixture, "Super Admin can use the dedicated assignment command");
  await migration.query("RESET ROLE");
  const assignmentAudit = await migration.query<{ count: number }>(
    `select count(*)::int as count from audit_event where target_type = 'CUSTOMER_ORDER_ITEM'
       and target_id = $1 and action = 'FULFILLMENT_ASSIGNMENT_CHANGED'`,
    [orderItemFixture],
  );
  assert.equal(assignmentAudit.rows[0]?.count, 2, "database assignment command records each actual change exactly once");

  phase = "exercising customer cancellation requests and assigned-Admin refund decisions";
  await migration.query("update order_item_fulfillment set work_started_at = now() where order_item_id = $1", [cancellationItem]);
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [userB, organizationB]);
  await expectPermissionDenied(migration, "cancellation request after fulfillment work starts", () => migration.query(
    "select public.gphkm_request_order_item_cancellation($1, $2, $3, $4, $5)",
    [cancellationItem, randomUUID(), `cancel-cutoff-${suffix}`, "1".repeat(64), "synthetic cutoff check"],
  ));
  await migration.query("RESET ROLE");
  await migration.query("update order_item_fulfillment set work_started_at = null where order_item_id = $1", [cancellationItem]);
  await migration.query("update order_item_fulfillment set handed_off_at = now() where order_item_id = $1", [cancellationItem]);
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [userB, organizationB]);
  await expectPermissionDenied(migration, "cancellation request after handoff", () => migration.query(
    "select public.gphkm_request_order_item_cancellation($1, $2, $3, $4, $5)",
    [cancellationItem, randomUUID(), `cancel-handoff-${suffix}`, "6".repeat(64), "synthetic handoff cutoff check"],
  ));
  await migration.query("RESET ROLE");
  await migration.query("update order_item_fulfillment set handed_off_at = null where order_item_id = $1", [cancellationItem]);

  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [userA, organizationA]);
  await expectPermissionDenied(migration, "cancellation request from a different organization", () => migration.query(
    "select public.gphkm_request_order_item_cancellation($1, $2, $3, $4, $5)",
    [cancellationItem, randomUUID(), `cancel-wrong-org-${suffix}`, "2".repeat(64), "synthetic tenant check"],
  ));
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [memberA, organizationB]);
  await expectPermissionDenied(migration, "same-organization member who did not place the order", () => migration.query(
    "select public.gphkm_request_order_item_cancellation($1, $2, $3, $4, $5)",
    [cancellationItem, randomUUID(), `cancel-nonowner-member-${suffix}`, "7".repeat(64), "synthetic non-owner check"],
  ));
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [userB, organizationB]);
  const requestDigest = "3".repeat(64);
  const requestKey = `cancel-request-${suffix}`;
  const cancellationRequested = await migration.query<{ id: string }>(
    "select public.gphkm_request_order_item_cancellation($1, $2, $3, $4, $5) as id",
    [cancellationItem, cancellationRequest, requestKey, requestDigest, "Synthetic cancellation request"],
  );
  assert.equal(cancellationRequested.rows[0]?.id, cancellationRequest, "customer request must persist under the restricted runtime role");
  const requestReplay = await migration.query<{ id: string }>(
    "select public.gphkm_request_order_item_cancellation($1, $2, $3, $4, $5) as id",
    [cancellationItem, cancellationRequest, requestKey, requestDigest, "Synthetic cancellation request"],
  );
  assert.equal(requestReplay.rows[0]?.id, cancellationRequest, "same request idempotency key and digest replay the original request");
  await expectUniqueViolation(migration, "cancellation request idempotency hash conflict", () => migration.query(
    "select public.gphkm_request_order_item_cancellation($1, $2, $3, $4, $5)",
    [cancellationItem, randomUUID(), requestKey, "4".repeat(64), "Synthetic changed request"],
  ));
  await migration.query("RESET ROLE");

  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [superAdminA]);
  await migration.query("select public.gphkm_assign_fulfillment_item($1, $2)", [cancellationItem, adminA]);
  await migration.query("select set_config('app.user_id', $1, true)", [adminB]);
  await expectPermissionDenied(migration, "unassigned Admin cancellation decision", () => migration.query(
    "select * from public.gphkm_decide_order_item_cancellation($1, 'DENIED', 'Synthetic denial review')", [cancellationRequest],
  ));
  await migration.query("select set_config('app.user_id', $1, true)", [adminA]);
  const deniedCancellation = await migration.query<{ outcome: string; amount_minor: string; ledger_id: string | null; applied: boolean }>(
    "select outcome, amount_minor::text, ledger_id, applied from public.gphkm_decide_order_item_cancellation($1, 'DENIED', 'Synthetic denial review')",
    [cancellationRequest],
  );
  assert.deepEqual(deniedCancellation.rows[0], { outcome: "DENIED", amount_minor: "0", ledger_id: null, applied: true },
    "Admin denial restores the previous fulfillment state and posts no wallet credit");
  const deniedReplay = await migration.query<{ applied: boolean }>(
    "select applied from public.gphkm_decide_order_item_cancellation($1, 'DENIED', 'Synthetic denial replay')", [cancellationRequest],
  );
  assert.equal(deniedReplay.rows[0]?.applied, false, "same denial replay is idempotent");
  await expectCheckConstraint(migration, "conflicting decision after cancellation denial", () => migration.query(
    "select * from public.gphkm_decide_order_item_cancellation($1, 'APPROVED', 'Synthetic conflicting approval')", [cancellationRequest],
  ));
  const denialState = await migration.query<{ state: string; state_before_cancellation: string | null; refund_count: number }>(
    `select f.state, f.state_before_cancellation,
       (select count(*)::int from wallet_ledger_entry l where l.operation = 'ITEM_CANCELLATION_REFUND' and l.related_id = $1) as refund_count
     from order_item_fulfillment f where f.order_item_id = $1`, [cancellationItem],
  );
  assert.deepEqual(denialState.rows[0], { state: "CONFIRMED", state_before_cancellation: null, refund_count: 0 },
    "denial restores the original state without refund entries");
  await migration.query("RESET ROLE");

  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [userB, organizationB]);
  const approvalRequest = await migration.query<{ id: string }>(
    "select public.gphkm_request_order_item_cancellation($1, $2, $3, $4, $5) as id",
    [cancellationItem, cancellationApprovalRequest, `cancel-approve-${suffix}`, "5".repeat(64), "Synthetic cancellation approval"],
  );
  assert.equal(approvalRequest.rows[0]?.id, cancellationApprovalRequest, "customer may open a new request after a prior request is denied");
  await migration.query("select set_config('app.user_id', $1, true)", [adminA]);
  const approvedCancellation = await migration.query<{ outcome: string; amount_minor: string; ledger_id: string; applied: boolean }>(
    "select outcome, amount_minor::text, ledger_id, applied from public.gphkm_decide_order_item_cancellation($1, 'APPROVED', 'Synthetic approved refund')",
    [cancellationApprovalRequest],
  );
  assert.equal(approvedCancellation.rows[0]?.outcome, "APPROVED");
  assert.equal(approvedCancellation.rows[0]?.amount_minor, "1500", "refund includes placement and both undelivered writing stages exactly");
  assert.ok(approvedCancellation.rows[0]?.ledger_id, "approved cancellation must return its immutable refund ledger id");
  assert.equal(approvedCancellation.rows[0]?.applied, true);
  const approvalReplay = await migration.query<{ amount_minor: string; ledger_id: string; applied: boolean }>(
    "select amount_minor::text, ledger_id, applied from public.gphkm_decide_order_item_cancellation($1, 'APPROVED', 'Synthetic approval replay')",
    [cancellationApprovalRequest],
  );
  assert.deepEqual(approvalReplay.rows[0], {
    amount_minor: "1500", ledger_id: approvedCancellation.rows[0]?.ledger_id, applied: false,
  }, "approval replay returns the original refund without applying it twice");
  await expectCheckConstraint(migration, "conflicting decision after cancellation approval", () => migration.query(
    "select * from public.gphkm_decide_order_item_cancellation($1, 'DENIED', 'Synthetic conflicting denial')", [cancellationApprovalRequest],
  ));
  await migration.query("RESET ROLE");
  const refundFacts = await migration.query<{ refund_count: number; delta_minor: string; refund_minor: string; ledger_id: string }>(
    `select (select count(*)::int from wallet_ledger_entry l where l.operation = 'ITEM_CANCELLATION_REFUND' and l.related_id = $1) as refund_count,
       l.delta_minor::text, c.refund_minor::text, c.wallet_ledger_entry_id as ledger_id
     from order_item_cancellation_request c join wallet_ledger_entry l on l.id = c.wallet_ledger_entry_id
     where c.id = $2`, [cancellationItem, cancellationApprovalRequest],
  );
  assert.deepEqual(refundFacts.rows[0], {
    refund_count: 1, delta_minor: "1500", refund_minor: "1500", ledger_id: approvedCancellation.rows[0]?.ledger_id,
  }, "one approval creates one matching ledger credit and immutable decision amount");
  const cancelledItem = await migration.query<{ state: string; customer_status: string }>(
    "select state, customer_status from order_item_fulfillment where order_item_id = $1", [cancellationItem],
  );
  assert.deepEqual(cancelledItem.rows[0], { state: "CANCELED_REFUNDED", customer_status: "RESOLVED" },
    "approved pre-handoff cancellation resolves the item");
  await migration.query("update order_item_fulfillment set assigned_admin_id = null where order_item_id = $1", [cancellationItem]);
  await migration.query("RESET ROLE");

  phase = "checking manual handoff reservation, evidence, and acknowledgement guards";
  await migration.query(
    "update order_item_fulfillment set state = 'READY_FOR_HANDOFF', assigned_admin_id = $2 where order_item_id = $1",
    [orderItemFixture, adminA],
  );
  await migration.query(
    `insert into supplier_packet (id, version, organization_id, order_id, supplier_id, recipient, packet, content_hash, created_by_user_id)
     select $1, 1, o.organization_id, o.id, $3, 'manual-supplier@example.invalid', '{\"items\":[{\"id\":\"manual-smoke\"}]}'::jsonb, repeat('f',64), $4
       from customer_order_item oi join customer_order o on o.id = oi.order_id where oi.id = $2`,
    [manualPacketId, orderItemFixture, supplierFixture, adminA],
  );
  await migration.query(
    `insert into supplier_packet_item (packet_id, order_item_id, assigned_admin_id, consent_notice_version, consented_at, consent_content_hash)
     select $1, oi.id, $3, oi.consent_notice_version, oi.consented_at, repeat('a',64)
       from customer_order_item oi where oi.id = $2`,
    [manualPacketId, orderItemFixture, adminA],
  );
  await migration.query("update order_item_fulfillment set state = 'HANDOFF_PENDING' where order_item_id = $1", [orderItemFixture]);
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [adminA, organizationA]);
  await migration.query(
    `insert into supplier_packet_attempt (id, packet_id, type, state, actor_user_id, recipient, idempotency_key)
     values ($1, $2, 'MANUAL_SEND', 'SENDING', $3, 'manual-supplier@example.invalid', $4)`,
    [manualPacketAttemptId, manualPacketId, adminA, `manual-reservation-${suffix}`],
  );
  await migration.query(
    `insert into supplier_packet_attempt_event (id, attempt_id, actor_user_id, actor_kind, from_state, to_state, reason_code)
     values ($1, $2, $3, 'STAFF', null, 'SENDING', 'MANUAL_SEND_RESERVED')`,
    [randomUUID(), manualPacketAttemptId, adminA],
  );
  const cancellationWhileReserved = await migration.query<{ allowed: boolean }>(
    "select public.gphkm_customer_can_request_item_cancellation($1, $2, $3) as allowed",
    [orderItemFixture, userA, organizationA],
  );
  assert.equal(cancellationWhileReserved.rows[0]?.allowed, false, "a manual reservation blocks ordinary cancellation before external send");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [userA, organizationA]);
  await expectPermissionDenied(migration, "cancellation request while supplier packet is reserved", () => migration.query(
    "select public.gphkm_request_order_item_cancellation($1, $2, $3, $4, $5)",
    [orderItemFixture, randomUUID(), `cancel-reserved-packet-${suffix}`, "8".repeat(64), "synthetic reserved packet check"],
  ));
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [adminA]);
  await migration.query(
    `insert into supplier_packet_attempt_event (id, attempt_id, actor_user_id, actor_kind, from_state, to_state, reason_code, reference)
     values ($1, $2, $3, 'STAFF', 'SENDING', 'MANUAL_SENT', 'MANUAL_HANDOFF_RECORDED', 'manual-smoke-reference')`,
    [randomUUID(), manualPacketAttemptId, adminA],
  );
  await migration.query(
    `update supplier_packet_attempt set state = 'MANUAL_SENT', manual_message_reference = 'manual-smoke-reference',
       sent_at = now(), resolved_at = now(), updated_at = now() where id = $1`, [manualPacketAttemptId],
  );
  const manualEvidenceId = randomUUID();
  await migration.query(
    `insert into supplier_packet_manual_evidence (id, packet_id, attempt_id, storage_key, file_kind, file_name, byte_size, content_sha256, uploaded_by_user_id)
     values ($1, $2, $3, $4, 'PDF', $5, 10, repeat('b',64), $6)`,
    [manualEvidenceId, manualPacketId, manualPacketAttemptId, randomUUID(), `handoff-${manualPacketAttemptId}.pdf`, adminA],
  );
  await migration.query(
    `insert into supplier_packet_acknowledgement (attempt_id, packet_id, recorded_by_user_id, acknowledged_at, reference)
     values ($1, $2, $3, now(), 'manual acknowledgement smoke')`,
    [manualPacketAttemptId, manualPacketId, adminA],
  );
  await migration.query("RESET ROLE");
  await migration.query(
    `update order_item_fulfillment set state = 'IN_FULFILLMENT', customer_status = 'IN_PROGRESS', handed_off_at = now(), work_started_at = now()
     where order_item_id = $1`, [orderItemFixture],
  );
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  const finalizedManualAttempt = await migration.query<{ state: string }>(
    "select state from supplier_packet_attempt where id = $1", [manualPacketAttemptId],
  );
  assert.equal(finalizedManualAttempt.rows[0]?.state, "MANUAL_SENT", "manual send, evidence, acknowledgement, and placement transition persist under the runtime role");
  await migration.query("RESET ROLE");

  phase = "checking Finance gross-profit projection and field boundary";
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [financeA]);
  const grossProfitRows = await migration.query(
    "select * from public.gphkm_finance_gross_profit_report(1)",
  );
  assert.ok(grossProfitRows.rows.length > 0, "Finance may view the paid order item in the gross-profit report");
  assert.deepEqual(Object.keys(grossProfitRows.rows[0]!).sort(), [
    "cost_status", "current_page", "gross_profit_minor", "known_direct_cost_minor", "order_item_id",
    "purchase_at", "refunded_minor", "retail_minor", "total_count", "total_pages",
  ].sort(), "Finance gross-profit projection must not expose customer or supplier contact/content fields");
  const grossProfitFixtureRow = grossProfitRows.rows.find((row) => row.order_item_id === orderItemFixture);
  assert.ok(grossProfitFixtureRow, "Finance gross-profit report must include the synthetic paid order item");
  assert.ok(["UNKNOWN", "PROVISIONAL"].includes(grossProfitFixtureRow.cost_status), "unconfirmed direct costs must retain a non-confirmed state");
  assert.equal(grossProfitFixtureRow.gross_profit_minor, null, "unknown direct costs must not be reported as confirmed gross profit");
  const confirmedCostEvent = randomUUID();
  await migration.query(
    `insert into audit_event (id, actor_user_id, action, target_type, target_id, reason_code, metadata)
     values ($1, $2, 'SUPPLIER_ORDER_COST_CORRECTED', 'supplier_order_item_cost_event', $1, 'ACTUAL_COST_CORRECTION', '{}'::jsonb)`,
    [confirmedCostEvent, financeA],
  );
  await migration.query("select set_config('app.user_id', $1, true)", [financeA]);
  await migration.query(
    `insert into supplier_order_item_cost_event
       (id, order_item_id, supplier_id, component, previous_cost_minor, new_cost_minor, reason, actor_user_id)
     values ($1, $2, $3, 'PLACEMENT', null, 300, 'Synthetic confirmed direct cost', $4)`,
    [confirmedCostEvent, orderItemFixture, supplierFixture, financeA],
  );
  const confirmedGrossProfitRows = await migration.query(
    "select * from public.gphkm_finance_gross_profit_report(1)",
  );
  const confirmedGrossProfitFixture = confirmedGrossProfitRows.rows.find((row) => row.order_item_id === orderItemFixture);
  assert.ok(confirmedGrossProfitFixture, "confirmed item remains visible in the gross-profit report");
  assert.equal(confirmedGrossProfitFixture.cost_status, "CONFIRMED");
  assert.equal(String(confirmedGrossProfitFixture.retail_minor), "1000");
  assert.equal(String(confirmedGrossProfitFixture.known_direct_cost_minor), "300");
  assert.equal(String(confirmedGrossProfitFixture.gross_profit_minor), "700", "gross profit uses exact minor-unit retail minus confirmed direct cost");
  await migration.query("select set_config('app.user_id', $1, true)", [adminA]);
  await migration.query("SAVEPOINT admin_gross_profit_denied");
  try {
    await migration.query("select * from public.gphkm_finance_gross_profit_report(1)");
    assert.fail("Admin must not view the Finance gross-profit report");
  } catch (error) {
    assert.equal(typeof error === "object" && error !== null && "code" in error ? error.code : null, "42501",
      "Admin must be denied the Finance gross-profit report");
  } finally {
    await migration.query("ROLLBACK TO SAVEPOINT admin_gross_profit_denied");
    await migration.query("RELEASE SAVEPOINT admin_gross_profit_denied");
  }
  await migration.query("RESET ROLE");

  phase = "proving isolated Resend packet and notification callbacks";
  await migration.query(
    `update order_item_fulfillment set state = 'READY_FOR_HANDOFF', assigned_admin_id = $2 where order_item_id = $1`,
    [orderItemFixtureTwo, superAdminA],
  );
  await migration.query(
    `insert into supplier_packet (id, version, organization_id, order_id, supplier_id, recipient, packet, content_hash, created_by_user_id)
     select $1, 1, o.organization_id, o.id, $3, 'supplier@example.invalid', '{"items":[{"id":"synthetic"}]}'::jsonb, repeat('c',64), $4
       from customer_order_item oi join customer_order o on o.id = oi.order_id where oi.id = $2`,
    [resendPacketId, orderItemFixtureTwo, supplierOtherFixture, adminA],
  );
  await migration.query(
    `insert into supplier_packet_item (packet_id, order_item_id, assigned_admin_id, consent_notice_version, consented_at, consent_content_hash)
     select $1, oi.id, $3, oi.consent_notice_version, oi.consented_at, repeat('d',64)
       from customer_order_item oi where oi.id = $2`,
    [resendPacketId, orderItemFixtureTwo, superAdminA],
  );
  await migration.query(
    `insert into supplier_packet_attempt (id, packet_id, type, state, actor_user_id, recipient, idempotency_key, provider)
     values ($1, $2, 'SEND', 'SENDING', $3, 'supplier@example.invalid', $4, 'RESEND')`,
    [resendPacketAttemptId, resendPacketId, adminA, `resend-smoke-${suffix}`],
  );
  await migration.query(
    `update order_item_fulfillment set state = 'HANDOFF_PENDING' where order_item_id = $1`, [orderItemFixtureTwo],
  );
  const resendEventId = `rls-smoke-${suffix}`;
  const resendEmailId = `rls-email-${suffix}`;
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query(`select set_config('app.resend_webhook_verified', 'true', true),
    set_config('app.resend_webhook_event_id', $1, true), set_config('app.resend_webhook_email_id', $2, true),
    set_config('app.resend_webhook_attempt_id', $3, true)`, [resendEventId, resendEmailId, resendPacketAttemptId]);
  const runtimePacket = await migration.query("select id from supplier_packet_attempt where id = $1", [resendPacketAttemptId]);
  assert.equal(runtimePacket.rowCount, 0, "general runtime cannot use Resend packet correlation policies");
  await expectWriteDenied(migration, "runtime Resend notification command", () => migration.query(
    `select * from public.gphkm_process_customer_notification_email_event($1, 'email.delivered', $2, null, repeat('a', 64), now())`,
    [resendEventId, resendEmailId],
  ));
  await migration.query("RESET ROLE");
  await migration.query("SET LOCAL ROLE gphkm_resend_webhook");
  await migration.query(`select set_config('app.resend_webhook_verified', 'true', true),
    set_config('app.resend_webhook_event_id', $1, true), set_config('app.resend_webhook_email_id', $2, true),
    set_config('app.resend_webhook_attempt_id', $3, true), set_config('app.organization_id', $4, true), set_config('app.user_id', '', true)`,
    [resendEventId, resendEmailId, resendPacketAttemptId, organizationB]);
  const allowedPacket = await migration.query("select id from supplier_packet_attempt where id = $1", [resendPacketAttemptId]);
  assert.equal(allowedPacket.rowCount, 1, "isolated Resend role can correlate its tagged packet attempt");
  await migration.query(
    `insert into supplier_packet_provider_event (id, provider_event_id, provider_email_id, attempt_id, event_type, payload_hash, state, processed_at)
     values ($1, $2, $3, $4, 'email.delivered', repeat('e',64), 'PROCESSED', now())`,
    [randomUUID(), resendEventId, resendEmailId, resendPacketAttemptId],
  );
  await migration.query("update supplier_packet_attempt set provider_reference = $2 where id = $1", [resendPacketAttemptId, resendEmailId]);
  await migration.query(
    `insert into supplier_packet_attempt_event (id, attempt_id, actor_user_id, actor_kind, from_state, to_state, reason_code, reference)
     values ($1, $2, null, 'PROVIDER', 'SENDING', 'DELIVERED', 'PROVIDER_DELIVERED', $3)`,
    [randomUUID(), resendPacketAttemptId, resendEventId],
  );
  await migration.query(`update supplier_packet_attempt set state = 'DELIVERED', delivered_at = now(), updated_at = now() where id = $1`, [resendPacketAttemptId]);
  phase = "finalizing Resend-backed item milestone";
  await migration.query(`update order_item_fulfillment set state = 'IN_FULFILLMENT', customer_status = 'IN_PROGRESS', handed_off_at = now(), work_started_at = now()
    where order_item_id = $1`, [orderItemFixtureTwo]);
  await migration.query(
    `insert into audit_event (id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
     values ($1, $2, null, 'FULFILLMENT_STATE_CHANGED', 'CUSTOMER_ORDER_ITEM', $3, 'PROVIDER_DELIVERED',
       '{"fromState":"HANDOFF_PENDING","toState":"IN_FULFILLMENT","result":"PROVIDER_CONFIRMED"}'::jsonb)`,
    [randomUUID(), organizationB, orderItemFixtureTwo],
  );
  const packetFulfillment = await migration.query<{ state: string; customer_status: string }>(
    "select state, customer_status from order_item_fulfillment where order_item_id = $1", [orderItemFixtureTwo],
  );
  assert.deepEqual(packetFulfillment.rows[0], { state: "IN_FULFILLMENT", customer_status: "IN_PROGRESS" },
    "Resend role processes a tagged delivery event and records its handoff milestone");
  const notificationWebhookResult = await migration.query<{ matched: boolean; duplicate: boolean; result_state: string }>(
    `select * from public.gphkm_process_customer_notification_email_event($1, 'email.delivered', $2, null, repeat('b', 64), now())`,
    [`notify-${suffix}`, `notify-email-${suffix}`],
  );
  assert.deepEqual(notificationWebhookResult.rows[0], { matched: false, duplicate: false, result_state: "RECONCILIATION_REQUIRED" },
    "Resend role can persist an unmatched synthetic notification event through the guarded command");
  const resendTableAccess = await migration.query<{ notification_select: boolean; stripe_execute: boolean; stripe_attach: boolean }>(
    `select has_table_privilege('gphkm_resend_webhook', 'public.customer_notification_email_outbox', 'SELECT') as notification_select,
      has_function_privilege('gphkm_resend_webhook', 'public.gphkm_process_stripe_event(text,text,text,text,text,text,text,numeric,text,text,timestamptz,text,text)', 'EXECUTE') as stripe_execute,
      has_function_privilege('gphkm_resend_webhook', 'public.gphkm_attach_stripe_event_facts(text,text,numeric,text,text)', 'EXECUTE') as stripe_attach`,
  );
  assert.deepEqual(resendTableAccess.rows[0], { notification_select: false, stripe_execute: false, stripe_attach: false },
    "Resend role has no notification table access and cannot call Stripe wallet commands");
  await migration.query("RESET ROLE");
  phase = "checking supplier identity consistency on order financial snapshots";
  await expectCheckConstraint(migration, "order snapshot with different source and fulfillment suppliers", () =>
    migration.query(
      `insert into order_item_financial (order_item_id, commercial_source, supplier_id, fulfillment_supplier_id)
       values ($1, 'SUPPLIER_SOURCED', $2, $3)`,
      [orderItemFixtureThree, supplierFixture, supplierOtherFixture],
    ),
  );
  await expectCheckConstraint(migration, "supplier order snapshot without a fulfillment supplier", () =>
    migration.query(
      `insert into order_item_financial (order_item_id, commercial_source, supplier_id, fulfillment_supplier_id)
       values ($1, 'SUPPLIER_SOURCED', $2, null)`,
      [orderItemFixtureThree, supplierFixture],
    ),
  );
  phase = "checking Finance-only supplier transfer event and allocation RLS";
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [financeA],
  );
  const eligibleSuppliers = await migration.query<{ original_allowed: boolean; replacement_allowed: boolean; unrelated_denied: boolean }>(
    `select public.gphkm_finance_item_supplier_allowed($1, $2) as original_allowed,
            public.gphkm_finance_item_supplier_allowed($1, $3) as replacement_allowed,
            public.gphkm_finance_item_supplier_allowed($1, 'not-a-supplier') as unrelated_denied`,
    [orderItemFixtureTwo, supplierFixture, supplierOtherFixture],
  );
  assert.deepEqual(eligibleSuppliers.rows[0], { original_allowed: true, replacement_allowed: true, unrelated_denied: false },
    "Finance may reconcile the immutable original supplier and the current approved replacement route only");
  const writingEligibility = await migration.query<{ not_selected_allowed: boolean; selected_allowed: boolean }>(
    "select public.gphkm_finance_writing_cost_allowed($1) as not_selected_allowed, public.gphkm_finance_writing_cost_allowed($2) as selected_allowed",
    [orderItemFixture, orderItemFixtureTwo],
  );
  assert.deepEqual(writingEligibility.rows[0], { not_selected_allowed: false, selected_allowed: true },
    "Finance writing-cost eligibility must follow the immutable purchased add-on snapshot");
  await migration.query(
    `insert into audit_event (id, actor_user_id, action, target_type, target_id, reason_code, metadata)
     values ($1, $2, 'SUPPLIER_TRANSFER_RECORDED', 'supplier_transfer_event', $3, 'RLS_SMOKE', '{}'::jsonb),
            ($4, $2, 'SUPPLIER_TRANSFER_ALLOCATED', 'supplier_transfer_allocation', $5, 'RLS_SMOKE', '{}'::jsonb),
            ($6, $2, 'SUPPLIER_TRANSFER_ALLOCATED', 'supplier_transfer_allocation', $7, 'RLS_SMOKE', '{}'::jsonb),
            ($8, $2, 'SUPPLIER_TRANSFER_RECORDED', 'supplier_transfer_event', $9, 'RLS_SMOKE', '{}'::jsonb),
            ($10, $2, 'SUPPLIER_TRANSFER_ALLOCATED', 'supplier_transfer_allocation', $11, 'RLS_SMOKE', '{}'::jsonb),
            ($12, $2, 'SUPPLIER_ORDER_COST_CORRECTED', 'supplier_order_item_cost_event', $13, 'RLS_SMOKE', '{}'::jsonb),
            ($14, $2, 'SUPPLIER_ORDER_COST_CORRECTED', 'supplier_order_item_cost_event', $15, 'RLS_SMOKE', '{}'::jsonb),
            ($16, $2, 'SUPPLIER_ORDER_COST_CORRECTED', 'supplier_order_item_cost_event', $17, 'RLS_SMOKE', '{}'::jsonb),
            ($18, $2, 'SUPPLIER_TRANSFER_EVIDENCE_ATTACHED', 'SUPPLIER_TRANSFER_EVIDENCE', $19, 'RLS_SMOKE', '{}'::jsonb),
            ($20, $2, 'SUPPLIER_TRANSFER_EVIDENCE_ATTACHED', 'SUPPLIER_TRANSFER_EVIDENCE', $21, 'RLS_SMOKE', '{}'::jsonb)`,
    [randomUUID(), financeA, transferFixture, randomUUID(), transferAllocationFixture, randomUUID(), transferAllocationFixtureTwo,
      randomUUID(), replacementTransferFixture, randomUUID(), replacementTransferAllocationFixture,
      randomUUID(), replacementCostFixture, randomUUID(), writingCostFixture, randomUUID(), nonWritingCostFixture,
      randomUUID(), transferEvidenceFixture, randomUUID(), replacementTransferEvidenceFixture],
  );
  await expectWriteDenied(migration, "writing cost on an item without the writing add-on", () => migration.query(
    `insert into supplier_order_item_cost_event (id, order_item_id, supplier_id, component, previous_cost_minor, new_cost_minor, reason, actor_user_id)
     values ($1, $2, null, 'WRITING', null, 50, 'Synthetic invalid non-writing cost', $3)`,
    [nonWritingCostFixture, orderItemFixture, financeA],
  ));
  await migration.query(
    `insert into supplier_transfer_event (id, idempotency_key, request_hash, supplier_id, amount_minor,
       transfer_date, transfer_reference, evidence_reference, reason, actor_user_id)
     values ($1, $2, repeat('a', 64), $3, 1000, now(), $4, 'Synthetic transfer evidence', 'RLS smoke', $5)`,
    [transferFixture, `transfer-${suffix}`, supplierFixture, `RLS-${suffix}`, financeA],
  );
  await migration.query(
    `insert into supplier_transfer_event (id, idempotency_key, request_hash, supplier_id, amount_minor,
       transfer_date, transfer_reference, evidence_reference, reason, actor_user_id)
     values ($1, $2, repeat('d', 64), $3, 100, now(), $4, 'Synthetic replacement transfer evidence', 'RLS smoke replacement', $5)`,
    [replacementTransferFixture, `replacement-transfer-${suffix}`, supplierOtherFixture, ` RLS-${suffix} `, financeA],
  );
  await migration.query(
    `insert into supplier_order_item_cost_event (id, order_item_id, supplier_id, component, previous_cost_minor, new_cost_minor, reason, actor_user_id)
     values ($1, $2, $3, 'PLACEMENT', null, 250, 'Synthetic replacement supplier cost', $4),
            ($5, $2, null, 'WRITING', null, 50, 'Synthetic internal writing cost', $4)`,
    [replacementCostFixture, orderItemFixtureTwo, supplierOtherFixture, financeA, writingCostFixture],
  );
  await migration.query(
    `insert into supplier_transfer_allocation (id, transfer_event_id, order_item_id, amount_minor, actor_user_id)
     values ($1, $2, $3, 600, $4), ($5, $2, $6, 400, $4), ($7, $8, $6, 100, $4)`,
    [transferAllocationFixture, transferFixture, orderItemFixture, financeA, transferAllocationFixtureTwo, orderItemFixtureTwo,
      replacementTransferAllocationFixture, replacementTransferFixture],
  );
  await migration.query(
    `insert into supplier_transfer_evidence (id, transfer_event_id, storage_key, file_kind, file_name, byte_size, content_sha256, uploaded_by_user_id)
     values ($1, $2, $3, 'PDF', 'synthetic-transfer-receipt.pdf', 5, repeat('a', 64), $4),
            ($5, $6, $7, 'EML', 'synthetic-transfer-receipt.eml', 5, repeat('b', 64), $4)`,
    [transferEvidenceFixture, transferFixture, randomUUID(), financeA, replacementTransferEvidenceFixture, replacementTransferFixture, randomUUID()],
  );
  const transferBeforeValidation = await migration.query<{ amount_minor: string; allocated_minor: string }>(
    `select event.amount_minor::text, coalesce(sum(allocation.amount_minor), 0)::text as allocated_minor
       from supplier_transfer_event event left join supplier_transfer_allocation allocation on allocation.transfer_event_id = event.id
      where event.id = $1 group by event.id`,
    [transferFixture],
  );
  assert.deepEqual(transferBeforeValidation.rows[0], { amount_minor: "1000", allocated_minor: "1000" }, "synthetic multi-item transfer fixture must be fully allocated before constraint validation");
  phase = "validating exact supplier transfer allocation total";
  await migration.query("SET CONSTRAINTS supplier_transfer_event_allocation_total, supplier_transfer_allocation_total IMMEDIATE");
  await migration.query("SET CONSTRAINTS supplier_transfer_event_allocation_total, supplier_transfer_allocation_total DEFERRED");
  const validTransferRows = await migration.query<{ allocation_total: string }>(
    `select sum(amount_minor)::text as allocation_total from supplier_transfer_allocation where transfer_event_id = $1`,
    [transferFixture],
  );
  assert.equal(validTransferRows.rows[0]?.allocation_total, "1000", "multi-item transfer allocations must reconcile exactly");
  const allocationCount = await migration.query<{ count: string }>(
    "select count(*)::text as count from supplier_transfer_allocation where transfer_event_id = $1", [transferFixture],
  );
  assert.equal(allocationCount.rows[0]?.count, "2", "one supplier transfer must support multiple order-item allocations");

  phase = "checking required supplier transfer evidence";
  await expectCheckConstraint(migration, "supplier transfer without a receipt", async () => {
    const noEvidenceTransfer = randomUUID();
    const noEvidenceAllocation = randomUUID();
    await migration.query(
      `insert into audit_event (id, actor_user_id, action, target_type, target_id, reason_code, metadata)
       values ($1, $2, 'SUPPLIER_TRANSFER_RECORDED', 'supplier_transfer_event', $3, 'RLS_SMOKE', '{}'::jsonb),
              ($4, $2, 'SUPPLIER_TRANSFER_ALLOCATED', 'supplier_transfer_allocation', $5, 'RLS_SMOKE', '{}'::jsonb)`,
      [randomUUID(), financeA, noEvidenceTransfer, randomUUID(), noEvidenceAllocation],
    );
    await migration.query(
      `insert into supplier_transfer_event (id, idempotency_key, request_hash, supplier_id, amount_minor,
         transfer_date, transfer_reference, evidence_reference, reason, actor_user_id)
       values ($1, $2, repeat('f', 64), $3, 100, now(), $4, 'RLS smoke missing receipt', 'RLS smoke', $5)`,
      [noEvidenceTransfer, `missing-evidence-${suffix}`, supplierFixture, `RLS-NO-EVIDENCE-${suffix}`, financeA],
    );
    await migration.query(
      `insert into supplier_transfer_allocation (id, transfer_event_id, order_item_id, amount_minor, actor_user_id)
       values ($1, $2, $3, 100, $4)`,
      [noEvidenceAllocation, noEvidenceTransfer, orderItemFixture, financeA],
    );
    await migration.query("SET CONSTRAINTS supplier_transfer_requires_evidence, supplier_transfer_event_allocation_total, supplier_transfer_allocation_total IMMEDIATE");
  });
  await migration.query("SET CONSTRAINTS supplier_transfer_requires_evidence, supplier_transfer_event_allocation_total, supplier_transfer_allocation_total DEFERRED");

  phase = "checking supplier-scoped case-insensitive transfer reference uniqueness";
  await expectUniqueViolation(migration, "duplicate trimmed/case-insensitive reference for the same supplier", async () => {
    const duplicateTransfer = randomUUID();
    await migration.query(
      `insert into audit_event (id, actor_user_id, action, target_type, target_id, reason_code, metadata)
       values ($1, $2, 'SUPPLIER_TRANSFER_RECORDED', 'supplier_transfer_event', $3, 'RLS_SMOKE', '{}'::jsonb)`,
      [randomUUID(), financeA, duplicateTransfer],
    );
    return migration.query(
      `insert into supplier_transfer_event (id, idempotency_key, request_hash, supplier_id, amount_minor,
         transfer_date, transfer_reference, evidence_reference, reason, actor_user_id)
       values ($1, $2, repeat('e', 64), $3, 100, now(), $4, 'Synthetic duplicate transfer evidence', 'RLS duplicate reference', $5)`,
      [duplicateTransfer, `duplicate-transfer-${suffix}`, supplierFixture, ` rls-${suffix} `, financeA],
    );
  });

  phase = "checking ordinary Admin transfer denial";
  await migration.query("select set_config('app.user_id', $1, true)", [adminA]);
  const deniedAdminTransfer = randomUUID();
  await migration.query(
    `insert into audit_event (id, actor_user_id, action, target_type, target_id, reason_code, metadata)
     values ($1, $2, 'SUPPLIER_TRANSFER_RECORDED', 'supplier_transfer_event', $3, 'RLS_SMOKE', '{}'::jsonb)`,
    [randomUUID(), adminA, deniedAdminTransfer],
  );
  await expectWriteDenied(migration, "Admin transfer insert", () => migration.query(
    `insert into supplier_transfer_event (id, idempotency_key, request_hash, supplier_id, amount_minor,
       transfer_date, transfer_reference, evidence_reference, reason, actor_user_id)
     values ($1, $2, repeat('c', 64), $3, 1000, now(), $4, 'Synthetic transfer evidence', 'RLS smoke', $5)`,
    [deniedAdminTransfer, `denied-transfer-${suffix}`, supplierFixture, `RLS-ADMIN-${suffix}`, adminA],
  ));
  const adminEvidenceVisibility = await migration.query<{ count: string }>(
    "select count(*)::text as count from supplier_transfer_evidence where id = $1", [transferEvidenceFixture],
  );
  assert.equal(adminEvidenceVisibility.rows[0]?.count, "0", "ordinary Admin must not read Finance supplier payment evidence");
  await migration.query("select set_config('app.user_id', $1, true)", [financeA]);

  const badTransfer = randomUUID();
  const badAllocation = randomUUID();
  const badTransferEvidence = randomUUID();
  await migration.query("SAVEPOINT transfer_bad_sum");
  let rejectedBadAllocationTotal = false;
  try {
    await migration.query(
      `insert into audit_event (id, actor_user_id, action, target_type, target_id, reason_code, metadata)
       values ($1, $2, 'SUPPLIER_TRANSFER_RECORDED', 'supplier_transfer_event', $3, 'RLS_SMOKE', '{}'::jsonb),
              ($4, $2, 'SUPPLIER_TRANSFER_ALLOCATED', 'supplier_transfer_allocation', $5, 'RLS_SMOKE', '{}'::jsonb),
              ($6, $2, 'SUPPLIER_TRANSFER_EVIDENCE_ATTACHED', 'SUPPLIER_TRANSFER_EVIDENCE', $7, 'RLS_SMOKE', '{}'::jsonb)`,
      [randomUUID(), financeA, badTransfer, randomUUID(), badAllocation, randomUUID(), badTransferEvidence],
    );
    await migration.query(
      `insert into supplier_transfer_event (id, idempotency_key, request_hash, supplier_id, amount_minor,
         transfer_date, transfer_reference, evidence_reference, reason, actor_user_id)
       values ($1, $2, repeat('b', 64), $3, 1000, now(), $4, 'Synthetic transfer evidence', 'RLS smoke', $5)`,
      [badTransfer, `bad-transfer-${suffix}`, supplierFixture, `RLS-BAD-${suffix}`, financeA],
    );
    await migration.query(
      `insert into supplier_transfer_allocation (id, transfer_event_id, order_item_id, amount_minor, actor_user_id)
       values ($1, $2, $3, 900, $4)`,
      [badAllocation, badTransfer, orderItemFixture, financeA],
    );
    await migration.query(
      `insert into supplier_transfer_evidence (id, transfer_event_id, storage_key, file_kind, file_name, byte_size, content_sha256, uploaded_by_user_id)
       values ($1, $2, $3, 'PDF', 'synthetic-bad-transfer.pdf', 5, repeat('c', 64), $4)`,
      [badTransferEvidence, badTransfer, randomUUID(), financeA],
    );
    await migration.query("SET CONSTRAINTS supplier_transfer_event_allocation_total, supplier_transfer_allocation_total IMMEDIATE");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23514") rejectedBadAllocationTotal = true;
    else throw error;
  } finally {
    await migration.query("ROLLBACK TO SAVEPOINT transfer_bad_sum");
    await migration.query("RELEASE SAVEPOINT transfer_bad_sum");
  }
  assert.ok(rejectedBadAllocationTotal, "database must reject allocations that do not equal the transfer amount");
  await migration.query("RESET ROLE");
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [adminA],
  );
  phase = "creating synthetic publication evidence";
  await migration.query(
    `insert into publication_evidence (id, order_item_id, live_url, method, verified_by_user_id)
     values ($1, $2, 'https://example.invalid/published', 'STAFF_MANUAL', $3)`,
    [originalEvidence, orderItemFixture, adminA],
  );
  phase = "completing synthetic fulfillment item";
  await migration.query(
    `update order_item_fulfillment set state = 'COMPLETED', customer_status = 'COMPLETE', assigned_admin_id = $2
     where order_item_id = $1`,
    [orderItemFixture, adminA],
  );
  phase = "checking publication evidence state guard";
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [adminA],
  );
  await expectWriteDenied(migration, "evidence insertion for completed item", () => migration.query(
    `insert into publication_evidence (id, order_item_id, live_url, method, verified_by_user_id)
     values ($1, $2, 'https://example.invalid/late-evidence', 'STAFF_MANUAL', $3)`,
    [randomUUID(), orderItemFixture, adminA],
  ));
  await migration.query("RESET ROLE");
  phase = "creating synthetic publication correction history";
  await migration.query(
    `insert into audit_event (id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
     values ($1, $2, $3, 'PUBLICATION_CORRECTION_OPENED', 'PUBLICATION_CORRECTION_CASE', $4,
       'INCORRECT_VERIFICATION', '{"result":"REOPENED_FOR_VERIFICATION"}'::jsonb)`,
    [randomUUID(), organizationA, adminA, correctionCase],
  );
  await migration.query(
    `insert into publication_correction_case (id, order_item_id, original_evidence_id, opened_by_user_id,
       reason, idempotency_key, request_hash)
     values ($1, $2, $3, $4, 'Synthetic correction fixture', $5, repeat('f', 64))`,
    [correctionCase, orderItemFixture, originalEvidence, adminA, `correction-${suffix}`],
  );
  await migration.query(
    `insert into publication_correction_event (id, correction_case_id, actor_user_id, event_type, reason)
     values ($1, $2, $3, 'OPENED', 'Synthetic rollback-only correction fixture')`,
    [randomUUID(), correctionCase, adminA],
  );
  await migration.query(
    `update order_item_fulfillment set state = 'PUBLICATION_PENDING', customer_status = 'LINK_VERIFICATION'
     where order_item_id = $1`,
    [orderItemFixture],
  );
  await migration.query(
    `insert into payment_attempt (id, organization_id, actor_user_id, provider, state, amount_minor, currency, idempotency_key, request_hash) values
       ($1, $2, $3, 'STRIPE', 'CREATED', 5000, 'USD', $4, repeat('d', 64)),
       ($5, $6, $7, 'STRIPE', 'CREATED', 5000, 'USD', $8, repeat('e', 64))`,
    [attemptA, organizationA, userA, `attempt-a-${suffix}`, attemptB, organizationB, userB, `attempt-b-${suffix}`],
  );
  phase = "checking durable Stripe session idempotency window";
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)",
    [userA, organizationA],
  );
  const firstSessionDispatch = await migration.query<{ may_create: boolean }>(
    "select public.gphkm_begin_stripe_checkout_session_create($1) as may_create", [attemptA],
  );
  assert.equal(firstSessionDispatch.rows[0]?.may_create, true, "first Stripe session dispatch must be durably reserved");
  const safeSessionRetry = await migration.query<{ may_create: boolean }>(
    "select public.gphkm_begin_stripe_checkout_session_create($1) as may_create", [attemptA],
  );
  assert.equal(safeSessionRetry.rows[0]?.may_create, true, "same-key Stripe retry remains available within the safe idempotency window");
  await migration.query("RESET ROLE");
  await migration.query(
    "update payment_attempt set checkout_session_create_started_at = clock_timestamp() - interval '25 hours' where id = $1",
    [attemptA],
  );
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)",
    [userA, organizationA],
  );
  const staleSessionRetry = await migration.query<{ may_create: boolean }>(
    "select public.gphkm_begin_stripe_checkout_session_create($1) as may_create", [attemptA],
  );
  assert.equal(staleSessionRetry.rows[0]?.may_create, false, "Stripe session creation must stop after the provider idempotency window");
  await migration.query("RESET ROLE");
  phase = "checking Finance evidence resolution for an ambiguous Stripe session";
  const absenceResolutionDefinition = await migration.query<{ definition: string }>(
    `select pg_get_functiondef('public.gphkm_resolve_missing_stripe_checkout_session(text, text, text)'::regprocedure) as definition`,
  );
  assert.match(absenceResolutionDefinition.rows[0]?.definition ?? "", /pg_advisory_xact_lock[\s\S]*gphkm:wallet-risk:/,
    "Finance absence resolution must share the organization Stripe-risk serialization lock");
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [financeA]);
  const ambiguousQueue = await migration.query<{ payment_attempt_id: string; eligible_for_evidence_resolution: boolean }>(
    "select payment_attempt_id, eligible_for_evidence_resolution from public.gphkm_list_ambiguous_stripe_checkout_attempts()",
  );
  assert.ok(ambiguousQueue.rows.some((row) => row.payment_attempt_id === attemptA && row.eligible_for_evidence_resolution),
    "Finance should see a dispatch older than 24 hours without a linked provider event as eligible for evidence review");
  await migration.query("select set_config('app.user_id', $1, true)", [adminA]);
  await expectWriteDenied(migration, "Admin cannot confirm ambiguous Stripe session absence", () =>
    migration.query("select public.gphkm_resolve_missing_stripe_checkout_session($1, 'stripe-dashboard-check', 'Confirmed no session or payment exists in Stripe Dashboard')", [attemptA]),
  );
  await migration.query("select set_config('app.user_id', $1, true)", [financeA]);
  const resolvedCheckout = await migration.query<{ gphkm_resolve_missing_stripe_checkout_session: string }>(
    "select public.gphkm_resolve_missing_stripe_checkout_session($1, 'stripe-dashboard-check', 'Confirmed no session or payment exists in Stripe Dashboard')",
    [attemptA],
  );
  assert.equal(resolvedCheckout.rows[0]?.gphkm_resolve_missing_stripe_checkout_session, attemptA,
    "Finance evidence resolution should close the stale attempt without wallet changes");
  await migration.query("RESET ROLE");
  const closedAttempt = await migration.query<{ state: string }>("select state from payment_attempt where id = $1", [attemptA]);
  assert.equal(closedAttempt.rows[0]?.state, "FAILED", "Finance resolution should release the open-top-up guard by closing only the attempt");
  await migration.query(
    "update payment_attempt set checkout_session_create_started_at = clock_timestamp() - interval '25 hours' where id = $1",
    [attemptB],
  );
  await migration.query(
    `insert into provider_event (id, provider, provider_event_id, state, payload_hash, payment_attempt_id)
     values ($1, 'STRIPE', $2, 'RECONCILIATION_REQUIRED', repeat('a', 64), $3)`,
    [randomUUID(), `rls-event-${suffix}`, attemptB],
  );
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [financeA]);
  const linkedEventQueue = await migration.query<{ eligible_for_evidence_resolution: boolean }>(
    "select eligible_for_evidence_resolution from public.gphkm_list_ambiguous_stripe_checkout_attempts() where payment_attempt_id = $1",
    [attemptB],
  );
  assert.equal(linkedEventQueue.rows[0]?.eligible_for_evidence_resolution, false,
    "an attempt with any linked provider event must stay in normal Stripe-event reconciliation");
  await migration.query("RESET ROLE");
  await migration.query(
    `insert into access_grant (id, organization_id, ledger_entry_id, policy_version, duration, state, starts_at, ends_at)
     values ($1, $2, $3, 1, 'SIX_MONTHS', 'ACTIVE', timezone('UTC', statement_timestamp()) - interval '1 day', timezone('UTC', statement_timestamp()) + interval '1 day'),
            ($4, $5, $6, 1, 'SIX_MONTHS', 'ACTIVE', timezone('UTC', statement_timestamp()) - interval '1 day', timezone('UTC', statement_timestamp()) + interval '1 day')`,
    [randomUUID(), organizationA, ledgerA, randomUUID(), organizationB, ledgerB],
  );
  await migration.query(
    `insert into wallet_hold (id, organization_id, amount_minor, state, reason_code) values
       ($1, $2, 250, 'ACTIVE', 'RLS_SMOKE'), ($3, $4, 350, 'ACTIVE', 'RLS_SMOKE')`,
    [holdA, organizationA, holdB, organizationB],
  );

  phase = "checking tenant reads as gphkm_runtime";
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  const effectiveRole = await migration.query<{ user: string }>("select current_user as user");
  assert.equal(effectiveRole.rows[0]?.user, "gphkm_runtime", "RLS checks must run as the actual runtime role");
  await migration.query(
    `select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)`,
    [userA, organizationA],
  );
  phase = "checking tenant wallet isolation";
  const visibleWallets = await migration.query<{ organization_id: string }>(
    "select organization_id from wallet_account order by organization_id",
  );
  assert.deepEqual(visibleWallets.rows.map((row) => row.organization_id), [organizationA]);
  phase = "checking tenant organization isolation";
  const visibleOrganizations = await migration.query<{ id: string }>("select id from organization order by id");
  assert.deepEqual(visibleOrganizations.rows.map((row) => row.id), [organizationA]);
  phase = "checking customer legal acceptance history isolation";
  const visibleLegalAcceptances = await migration.query<{ id: string }>("select id from customer_legal_acceptance order by id");
  assert.deepEqual(visibleLegalAcceptances.rows.map((row) => row.id), [legalAcceptanceA], "customer legal history must be limited to its actor");
  phase = "checking tenant member-directory isolation";
  const visibleMembers = await migration.query<{ organization_id: string; user_id: string }>(
    "select organization_id, user_id from organization_member order by user_id",
  );
  assert.deepEqual(visibleMembers.rows.map((row) => row.user_id).sort(), [userA, memberA].sort());
  phase = "checking tenant order visibility";
  const visibleOrders = await migration.query<{ id: string }>("select id from customer_order order by id");
  assert.deepEqual(visibleOrders.rows.map((row) => row.id).sort(), [ownerOrderA, checkoutOrderFixture, memberOrderA].sort());
  phase = "checking customer milestone history tenant isolation";
  const visibleMilestones = await migration.query<{ order_item_id: string; status: string }>(
    "select distinct order_item_id, status from customer_order_item_milestone order by order_item_id, status",
  );
  assert.deepEqual(
    [...new Set(visibleMilestones.rows.map((row) => row.order_item_id))].sort(),
    [orderItemFixture, checkoutOrderItemFixture, checkoutOrderItemFixtureTwo].sort(),
    "customer milestone history must contain this organization's items and exclude another tenant",
  );
  phase = "checking assigned-only staff milestone history";
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [adminA]);
  const assignedMilestones = await migration.query<{ order_item_id: string }>(
    "select order_item_id from customer_order_item_milestone order by order_item_id",
  );
  assert.ok(assignedMilestones.rows.length > 0 && assignedMilestones.rows.every((row) => row.order_item_id === orderItemFixture),
    "assigned Admin must see its item milestones and no unassigned items");
  await migration.query("select set_config('app.user_id', $1, true)", [adminB]);
  const unassignedMilestones = await migration.query("select order_item_id from customer_order_item_milestone");
  assert.equal(unassignedMilestones.rowCount, 0, "unassigned Admin must not read item milestone history");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [userA, organizationA]);
  phase = "checking owner-only wallet history";
  const visibleLedger = await migration.query<{ id: string }>("select id from wallet_ledger_entry order by id");
  assert.deepEqual(visibleLedger.rows.map((row) => row.id).sort(), [ledgerA, orderDebitA, checkoutLedgerId].sort());
  const visibleAttempts = await migration.query<{ id: string }>("select id from payment_attempt order by id");
  assert.deepEqual(visibleAttempts.rows.map((row) => row.id), [attemptA]);
  phase = "checking owner-only wallet holds and access grants";
  const visibleHolds = await migration.query<{ id: string }>("select id from wallet_hold order by id");
  assert.deepEqual(visibleHolds.rows.map((row) => row.id), [holdA]);
  const visibleGrants = await migration.query<{ organization_id: string }>("select organization_id from access_grant");
  assert.deepEqual(visibleGrants.rows.map((row) => row.organization_id), [organizationA], "owner may inspect linked grant history");
  const ownerAccess = await migration.query<{ active: boolean }>(
    "select public.gphkm_customer_has_marketplace_access($1) as active", [organizationA],
  );
  assert.equal(ownerAccess.rows[0]?.active, true, "owner may use the access-decision projection");
  const heldTotal = await migration.query<{ amount_minor: string }>(
    "select public.gphkm_customer_wallet_held_total($1)::text as amount_minor", [organizationA],
  );
  assert.equal(heldTotal.rows[0]?.amount_minor, "250", "owner may use the sanitized held-total projection");
  const crossTenantWallet = await migration.query(
    "select organization_id from wallet_account where organization_id = $1",
    [organizationB],
  );
  assert.equal(crossTenantWallet.rowCount, 0, "runtime must not read a different organization with the active tenant context");
  const crossTenantOrder = await migration.query("select id from customer_order where id = $1", [ownerOrderB]);
  assert.equal(crossTenantOrder.rowCount, 0, "runtime must not read a different organization's orders");

  phase = "checking assigned staff access to correction history";
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [adminA],
  );
  const assignedCases = await migration.query<{ id: string }>("select id from publication_correction_case");
  assert.deepEqual(assignedCases.rows.map((row) => row.id), [correctionCase], "assigned Admin may read item correction history");
  const assignedCorrectionEvents = await migration.query<{ correction_case_id: string }>("select correction_case_id from publication_correction_event");
  assert.deepEqual(assignedCorrectionEvents.rows.map((row) => row.correction_case_id), [correctionCase], "assigned Admin may read correction events");
  await migration.query("select set_config('app.user_id', $1, true)", [adminB]);
  const unassignedCases = await migration.query("select id from publication_correction_case");
  assert.equal(unassignedCases.rowCount, 0, "unassigned Admin must not read item correction cases");
  const unassignedCorrectionEvents = await migration.query("select id from publication_correction_event");
  assert.equal(unassignedCorrectionEvents.rowCount, 0, "unassigned Admin must not read item correction events");
  await expectWriteDenied(migration, "correction case update", () => migration.query(
    "update publication_correction_case set reason = 'tampered' where id = $1", [correctionCase],
  ));
  await expectWriteDenied(migration, "correction event update", () => migration.query(
    "update publication_correction_event set reason = 'tampered' where correction_case_id = $1", [correctionCase],
  ));

  phase = "checking member wallet-history restrictions and own-order visibility";
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)",
    [memberA, organizationA],
  );
  const memberWallet = await migration.query<{ organization_id: string }>("select organization_id from wallet_account");
  assert.deepEqual(memberWallet.rows.map((row) => row.organization_id), [organizationA], "members may see the organization balance");
  for (const [name, table] of [["wallet ledger", "wallet_ledger_entry"], ["top-up attempts", "payment_attempt"], ["wallet holds", "wallet_hold"]] as const) {
    const records = await migration.query(`select 1 from public.${table} limit 1`);
    assert.equal(records.rowCount, 0, `members must not read ${name}`);
  }
  const memberGrants = await migration.query("select 1 from access_grant limit 1");
  assert.equal(memberGrants.rowCount, 0, "members must not inspect access grant intervals");
  const memberAccess = await migration.query<{ active: boolean }>(
    "select public.gphkm_customer_has_marketplace_access($1) as active", [organizationA],
  );
  assert.equal(memberAccess.rows[0]?.active, true, "members may use the sanitized access decision");
  const memberOrders = await migration.query<{ id: string }>("select id from customer_order order by id");
  assert.deepEqual(memberOrders.rows.map((row) => row.id), [memberOrderA], "members may read their own orders only");
  const memberHeldTotal = await migration.query<{ amount_minor: string }>(
    "select public.gphkm_customer_wallet_held_total($1)::text as amount_minor", [organizationA],
  );
  assert.equal(memberHeldTotal.rows[0]?.amount_minor, "250", "members may use held funds for availability without reading hold records");

  phase = "checking that an organization context cannot bypass membership";
  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)",
    [userA, organizationB],
  );
  const spoofedWallet = await migration.query("select organization_id from wallet_account where organization_id = $1", [organizationB]);
  assert.equal(spoofedWallet.rowCount, 0, "RLS must verify membership instead of trusting organization context alone");
  const spoofedMembers = await migration.query("select user_id from organization_member where organization_id = $1", [organizationB]);
  assert.equal(spoofedMembers.rowCount, 0, "RLS must not expose another tenant's member directory through context alone");
  const spoofedGrantRows = await migration.query("select id from access_grant where organization_id = $1", [organizationB]);
  assert.equal(spoofedGrantRows.rowCount, 0, "RLS must not expose another tenant's grant history through context alone");
  await migration.query("SAVEPOINT rls_nonmember_projection");
  try {
    await migration.query("select public.gphkm_customer_has_marketplace_access($1)", [organizationB]);
    assert.fail("a nonmember must not call the access projection");
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
  } finally {
    await migration.query("ROLLBACK TO SAVEPOINT rls_nonmember_projection");
    await migration.query("RELEASE SAVEPOINT rls_nonmember_projection");
  }
  await migration.query("SAVEPOINT rls_nonmember_wallet_projection");
  try {
    await migration.query("select public.gphkm_customer_wallet_held_total($1)", [organizationB]);
    assert.fail("a nonmember must not call the held-total projection");
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
  } finally {
    await migration.query("ROLLBACK TO SAVEPOINT rls_nonmember_wallet_projection");
    await migration.query("RELEASE SAVEPOINT rls_nonmember_wallet_projection");
  }

  await migration.query(
    "select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)",
    [userA, organizationA],
  );

  phase = "checking blocked direct wallet writes";
  await expectWriteDenied(migration, "wallet balance update", () => migration.query(
    "update wallet_account set balance_minor = 1 where organization_id = $1",
    [organizationA],
  ));
  await expectWriteDenied(migration, "direct wallet ledger insert", () => migration.query(
    `insert into wallet_ledger_entry (id, organization_id, actor_user_id, kind, delta_minor, operation, idempotency_key)
     values ($1, $2, $3, 'ORDER_DEBIT', -1, 'ORDER_CHECKOUT', 'rls-smoke')`,
    [randomUUID(), organizationA, userA],
  ));
  await migration.query("RESET ROLE");
  phase = "checking idempotent Stripe success after dispute";
  const disputedSession = `cs_${randomUUID().replaceAll("-", "")}`;
  const disputedPaymentIntent = `pi_${randomUUID().replaceAll("-", "")}`;
  await migration.query(
    `insert into payment_attempt (id, organization_id, actor_user_id, provider, state, amount_minor, currency,
       idempotency_key, request_hash, provider_checkout_session_id, provider_payment_id, settled_at)
     values ($1, $2, $3, 'STRIPE', 'DISPUTED', 5000, 'USD', $4, repeat('f',64), $5, $6, now())`,
    [disputedAttempt, organizationA, userA, `disputed-attempt-${suffix}`, disputedSession, disputedPaymentIntent],
  );
  await migration.query(
    `insert into wallet_ledger_entry (id, organization_id, actor_user_id, kind, delta_minor, currency,
       operation, idempotency_key, related_type, related_id, reason_code)
     values ($1, $2, $3, 'TOP_UP', 5000, 'USD', 'STRIPE_TOP_UP', $4, 'PAYMENT_ATTEMPT', $4, 'STRIPE_SETTLED')`,
    [randomUUID(), organizationA, userA, disputedAttempt],
  );
  const walletBeforeLateEvent = await migration.query<{ balance_minor: string }>(
    "select balance_minor::text from wallet_account where organization_id = $1", [organizationA],
  );
  const lateSuccessEvent = `evt_${randomUUID().replaceAll("-", "")}`;
  await migration.query("SET LOCAL ROLE gphkm_webhook");
  const lateSuccess = await migration.query<{ gphkm_process_stripe_event: string }>(
    `select public.gphkm_process_stripe_event($1, 'checkout.session.completed', repeat('a',64), $2,
       $3, $2, $4, 5000, 'usd', 'paid', now(), null, null)`,
    [lateSuccessEvent, disputedSession, disputedAttempt, disputedPaymentIntent],
  );
  assert.equal(lateSuccess.rows[0]?.gphkm_process_stripe_event, "PROCESSED",
    "a matching late Checkout success after dispute is recorded without re-running settlement");
  await migration.query("RESET ROLE");
  const settledRows = await migration.query<{ count: string; state: string; event_state: string }>(
    `select count(l.id)::text as count, a.state,
       (select e.state from provider_event e where e.provider_event_id = $2) as event_state
     from payment_attempt a left join wallet_ledger_entry l
       on l.organization_id = a.organization_id and l.operation = 'STRIPE_TOP_UP' and l.idempotency_key = a.id
     where a.id = $1 group by a.state`, [disputedAttempt, lateSuccessEvent],
  );
  assert.deepEqual(settledRows.rows[0], { count: "1", state: "DISPUTED", event_state: "PROCESSED" },
    "late success must preserve dispute state and exactly one existing top-up ledger entry");
  const walletAfterLateEvent = await migration.query<{ balance_minor: string }>(
    "select balance_minor::text from wallet_account where organization_id = $1", [organizationA],
  );
  assert.equal(walletAfterLateEvent.rows[0]?.balance_minor, walletBeforeLateEvent.rows[0]?.balance_minor,
    "late success must not credit the wallet a second time");

  const conflictingSuccessEvent = `evt_${randomUUID().replaceAll("-", "")}`;
  await migration.query("SET LOCAL ROLE gphkm_webhook");
  const conflictingSuccess = await migration.query<{ gphkm_process_stripe_event: string }>(
    `select public.gphkm_process_stripe_event($1, 'checkout.session.completed', repeat('b',64), $2,
       $3, $2, $4, 5001, 'usd', 'paid', now(), null, null)`,
    [conflictingSuccessEvent, disputedSession, disputedAttempt, disputedPaymentIntent],
  );
  assert.equal(conflictingSuccess.rows[0]?.gphkm_process_stripe_event, "RECONCILIATION_REQUIRED",
    "contradictory late success facts must enter Finance reconciliation");
  await migration.query("RESET ROLE");
  const conflictEvent = await migration.query<{ state: string; payment_attempt_id: string }>(
    "select state, payment_attempt_id from provider_event where provider_event_id = $1", [conflictingSuccessEvent],
  );
  assert.deepEqual(conflictEvent.rows[0], { state: "RECONCILIATION_REQUIRED", payment_attempt_id: disputedAttempt },
    "conflicting event must be linked to the disputed attempt for Finance review");
  const walletAfterConflict = await migration.query<{ balance_minor: string }>(
    "select balance_minor::text from wallet_account where organization_id = $1", [organizationA],
  );
  assert.equal(walletAfterConflict.rows[0]?.balance_minor, walletBeforeLateEvent.rows[0]?.balance_minor,
    "conflicting late success must not change wallet funds");

  phase = "checking Finance access recovery after a provider-confirmed failed refund";
  const refundAttempts = [
    { attempt: failedRefundAttempt, ledger: failedRefundLedger, grant: failedRefundGrant, hold: failedRefundHold, refundStatus: "failed" as const },
    { attempt: partialRefundAttempt, ledger: partialRefundLedger, grant: partialRefundGrant, hold: partialRefundHold, refundStatus: "succeeded" as const },
    { attempt: pendingRefundAttempt, ledger: pendingRefundLedger, grant: pendingRefundGrant, hold: pendingRefundHold, refundStatus: "failed" as const },
    { attempt: staleRefundAttempt, ledger: staleRefundLedger, grant: staleRefundGrant, hold: staleRefundHold, refundStatus: "failed" as const },
    { attempt: openDisputeRefundAttempt, ledger: openDisputeRefundLedger, grant: openDisputeRefundGrant, hold: openDisputeRefundHold, refundStatus: "failed" as const },
    { attempt: incompleteRefundAttempt, ledger: incompleteRefundLedger, grant: incompleteRefundGrant, hold: incompleteRefundHold, refundStatus: "failed" as const },
    { attempt: canceledRefundAttempt, ledger: canceledRefundLedger, grant: canceledRefundGrant, hold: canceledRefundHold, refundStatus: "failed" as const },
  ];
  for (const [index, item] of refundAttempts.entries()) {
    const paymentIntent = `pi_${item.attempt.replaceAll("-", "")}`;
    await migration.query(
      `insert into payment_attempt (id, organization_id, actor_user_id, provider, state, amount_minor, currency,
         idempotency_key, request_hash, provider_payment_id, settled_at)
       values ($1, $2, $3, 'STRIPE', 'SETTLED', 5000, 'USD', $4, repeat($5,64), $6, now())`,
      [item.attempt, organizationA, userA, `refund-review-${suffix}-${index}`, index ? "e" : "d", paymentIntent],
    );
    await migration.query(
      `insert into wallet_ledger_entry (id, organization_id, actor_user_id, kind, delta_minor, currency,
         operation, idempotency_key, related_type, related_id, reason_code)
       values ($1, $2, $3, 'TOP_UP', 5000, 'USD', 'STRIPE_TOP_UP', $4, 'PAYMENT_ATTEMPT', $4, 'STRIPE_SETTLED')`,
      [item.ledger, organizationA, userA, item.attempt],
    );
    await migration.query(
      `insert into access_grant (id, organization_id, ledger_entry_id, policy_version, duration, state,
         starts_at, ends_at, suspension_reason)
       values ($1, $2, $3, 1, 'SIX_MONTHS', 'REVOKED', now() - interval '1 day', now() + interval '5 months', 'STRIPE_REVERSAL')`,
      [item.grant, organizationA, item.ledger],
    );
    await migration.query("update payment_attempt set state = 'REVERSED' where id = $1", [item.attempt]);
    await migration.query(
      `insert into provider_event (id, provider, provider_event_id, state, payload_hash, payment_attempt_id, event_type,
         provider_object_id, related_payment_id)
       values ($1, 'STRIPE', $2, 'RECONCILIATION_REQUIRED', repeat('a',64), $3, 'charge.refunded', $4, $4)`,
      [randomUUID(), `evt_${item.attempt.replaceAll("-", "")}`, item.attempt, paymentIntent],
    );
    await migration.query(
      `insert into wallet_hold (id, organization_id, ledger_entry_id, payment_attempt_id, amount_minor, state, reason_code)
       values ($1, $2, $3, $4, 200, 'ACTIVE', 'STRIPE_REFUND')`,
      [item.hold, organizationA, item.ledger, item.attempt],
    );
  }
  const failedIntervalBefore = await migration.query<{ starts_at: string; ends_at: string }>(
    "select starts_at::text, ends_at::text from access_grant where id = $1", [failedRefundGrant],
  );

  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [financeA]);
  const storeFinanceSnapshot = async (
    attemptId: string,
    refundStatus: "failed" | "succeeded" | "canceled",
    overrides: { complete?: boolean; refreshedAt?: string; refreshStartedAt?: string; pendingRefundCount?: number; openDisputeCount?: number; disputes?: unknown[] } = {},
  ) => {
    let refreshId: string;
    let refreshedAt = overrides.refreshedAt;
    if (overrides.refreshStartedAt) {
      refreshId = randomUUID();
      await migration.query("RESET ROLE");
      await migration.query(
        "insert into stripe_finance_refresh (id, payment_attempt_id, actor_user_id, started_at) values ($1, $2, $3, $4)",
        [refreshId, attemptId, financeA, overrides.refreshStartedAt],
      );
      await migration.query("SET LOCAL ROLE gphkm_runtime");
    } else {
      const refresh = await migration.query<{ refresh_id: string }>(
        "select refresh_id from public.gphkm_start_stripe_finance_refresh($1)", [attemptId],
      );
      refreshId = refresh.rows[0]!.refresh_id;
    }
    if (!refreshedAt) {
      const timestamp = await migration.query<{ refreshed_at: string }>(
        `select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as refreshed_at`,
      );
      refreshedAt = timestamp.rows[0]!.refreshed_at;
    }
    const paymentIntent = `pi_${attemptId.replaceAll("-", "")}`;
    const facts: Record<string, unknown> = {
      detailComplete: true,
      paginationComplete: true,
      snapshotTruncated: false,
      providerPaymentId: paymentIntent,
      amountMinor: "5000",
      currency: "usd",
      paymentStatus: "succeeded",
      amountReceivedMinor: "5000",
      chargeId: `ch_${attemptId.replaceAll("-", "")}`,
      chargeBalanceTransaction: { amountMinor: "5000", feeMinor: "100", netMinor: "4900", currency: "usd" },
      providerMode: "test",
      refreshedAt,
      pendingRefundCount: overrides.pendingRefundCount ?? 0,
      openDisputeCount: overrides.openDisputeCount ?? 0,
      refunds: refundStatus === "failed" || refundStatus === "canceled"
        ? [{ id: `re_${attemptId.replaceAll("-", "")}`, status: refundStatus, currency: "usd" }]
        : [{ id: `re_${attemptId.replaceAll("-", "")}`, status: "succeeded", currency: "usd",
            balanceTransaction: { id: `txn_${attemptId.replaceAll("-", "")}`, amountMinor: -100,
              status: "available", currency: "usd" } }],
      disputes: overrides.disputes ?? [],
      refreshId,
    };
    const snapshot = await migration.query<{ snapshot_id: string }>(
      "select public.gphkm_store_stripe_finance_snapshot($1, repeat('b',64), $3, $2::jsonb) as snapshot_id",
      [attemptId, JSON.stringify(facts), overrides.complete ?? true],
    );
    return snapshot.rows[0]!.snapshot_id;
  };
  // Generate stale refresh timestamps from PostgreSQL's own clock so the
  // synthetic refresh token stays internally consistent even if the Node
  // runner and database container clocks differ slightly in CI.
  const staleTimestamp = await migration.query<{ stale_at: string; refresh_started_at: string }>(
    `select to_char((clock_timestamp() - interval '30 minutes') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as stale_at,
            to_char((clock_timestamp() - interval '31 minutes') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as refresh_started_at`,
  );
  const staleAt = staleTimestamp.rows[0]!.stale_at;
  const staleSnapshotId = await storeFinanceSnapshot(staleRefundAttempt, "failed", {
    refreshedAt: staleAt,
    refreshStartedAt: staleTimestamp.rows[0]!.refresh_started_at,
  });
  await expectCheckConstraint(migration, "stale Stripe snapshot resolution", () => migration.query(
    `select * from public.gphkm_resolve_stripe_reconciliation_case($1, $2, 'Synthetic stale provider snapshot',
       'A stale provider snapshot must not restore access')`, [staleRefundAttempt, staleSnapshotId],
  ));
  const pendingSnapshotId = await storeFinanceSnapshot(pendingRefundAttempt, "failed", { pendingRefundCount: 1 });
  await expectCheckConstraint(migration, "pending Stripe refund resolution", () => migration.query(
    `select * from public.gphkm_resolve_stripe_reconciliation_case($1, $2, 'Synthetic pending refund review',
       'A pending provider refund must not restore access')`, [pendingRefundAttempt, pendingSnapshotId],
  ));
  const disputeSnapshotId = await storeFinanceSnapshot(openDisputeRefundAttempt, "failed", {
    openDisputeCount: 1,
    disputes: [{ id: `dp_${openDisputeRefundAttempt.replaceAll("-", "")}`, status: "needs_response", currency: "usd" }],
  });
  await expectCheckConstraint(migration, "open dispute Stripe snapshot resolution", () => migration.query(
    `select * from public.gphkm_resolve_stripe_reconciliation_case($1, $2, 'Synthetic open dispute review',
       'An unresolved dispute must not restore access')`, [openDisputeRefundAttempt, disputeSnapshotId],
  ));
  const incompleteSnapshotId = await storeFinanceSnapshot(incompleteRefundAttempt, "failed", { complete: false });
  await expectCheckConstraint(migration, "incomplete Stripe snapshot resolution", () => migration.query(
    `select * from public.gphkm_resolve_stripe_reconciliation_case($1, $2, 'Synthetic incomplete provider snapshot',
       'An incomplete provider snapshot must not restore access')`, [incompleteRefundAttempt, incompleteSnapshotId],
  ));
  const failedSnapshotId = await storeFinanceSnapshot(failedRefundAttempt, "failed");
  const failedRefundDecision = await migration.query<{ provider_loss_minor: string; wallet_recovery_minor: string; uncovered_minor: string }>(
    `select * from public.gphkm_resolve_stripe_reconciliation_case($1, $2, 'Synthetic Stripe Dashboard refund verification',
       'The provider confirms the only refund failed; access should be restored')`, [failedRefundAttempt, failedSnapshotId],
  );
  assert.deepEqual(failedRefundDecision.rows[0], { provider_loss_minor: "0", wallet_recovery_minor: "0", uncovered_minor: "0" },
    "failed refund snapshot resolves with no principal loss");
  const canceledSnapshotId = await storeFinanceSnapshot(canceledRefundAttempt, "canceled");
  const canceledRefundDecision = await migration.query<{ provider_loss_minor: string; wallet_recovery_minor: string; uncovered_minor: string }>(
    `select * from public.gphkm_resolve_stripe_reconciliation_case($1, $2, 'Synthetic canceled Stripe refund verification',
       'The provider confirms the only refund was canceled; access should be restored')`, [canceledRefundAttempt, canceledSnapshotId],
  );
  assert.deepEqual(canceledRefundDecision.rows[0], { provider_loss_minor: "0", wallet_recovery_minor: "0", uncovered_minor: "0" },
    "canceled refund snapshot resolves with no principal loss");
  await migration.query("RESET ROLE");
  const failedRefundState = await migration.query<{ attempt_state: string; grant_state: string; suspension_reason: string | null; hold_state: string; interval_matches: boolean }>(
    `select a.state as attempt_state, g.state as grant_state, g.suspension_reason,
       h.state as hold_state, g.starts_at = $3::timestamptz and g.ends_at = $4::timestamptz as interval_matches
       from payment_attempt a join access_grant g on g.id = $2 and g.ledger_entry_id = (
         select l.id from wallet_ledger_entry l where l.operation = 'STRIPE_TOP_UP' and l.idempotency_key = a.id
       ) join wallet_hold h on h.payment_attempt_id = a.id where a.id = $1`,
    [failedRefundAttempt, failedRefundGrant, failedIntervalBefore.rows[0]!.starts_at, failedIntervalBefore.rows[0]!.ends_at],
  );
  assert.deepEqual(failedRefundState.rows[0], {
    attempt_state: "SETTLED", grant_state: "ACTIVE", suspension_reason: null, hold_state: "RELEASED", interval_matches: true,
  }, "confirmed failed refund restores only the linked grant, releases its hold, and preserves dates");
  const canceledRefundState = await migration.query<{ attempt_state: string; grant_state: string }>(
    `select a.state as attempt_state, g.state as grant_state from payment_attempt a
       join access_grant g on g.id = $2 and g.ledger_entry_id = (
         select l.id from wallet_ledger_entry l where l.operation = 'STRIPE_TOP_UP' and l.idempotency_key = a.id
       ) where a.id = $1`, [canceledRefundAttempt, canceledRefundGrant],
  );
  assert.deepEqual(canceledRefundState.rows[0], { attempt_state: "SETTLED", grant_state: "ACTIVE" },
    "confirmed canceled refund restores its own linked access grant");
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [financeA]);
  await migration.query(
    `select * from public.gphkm_resolve_stripe_reconciliation_case($1, $2, 'Synthetic Stripe Dashboard refund verification',
       'The provider confirms the only refund failed; access should be restored')`, [failedRefundAttempt, failedSnapshotId],
  );
  await migration.query("RESET ROLE");
  const restoreAuditCount = await migration.query<{ count: number }>(
    `select count(*)::int as count from audit_event where action = 'STRIPE_FAILED_REFUND_ACCESS_RESTORED'
       and target_type = 'ACCESS_GRANT' and target_id = $1`, [failedRefundGrant],
  );
  assert.equal(restoreAuditCount.rows[0]?.count, 1, "same-snapshot Finance retry must not duplicate the access-restoration audit");

  phase = "checking successful partial-refund access denial";
  await migration.query("SET LOCAL ROLE gphkm_runtime");
  await migration.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [financeA]);
  const partialSnapshotId = await storeFinanceSnapshot(partialRefundAttempt, "succeeded");
  const partialDecision = await migration.query<{ provider_loss_minor: string; wallet_recovery_minor: string; uncovered_minor: string }>(
    `select * from public.gphkm_resolve_stripe_reconciliation_case($1, $2, 'Synthetic Stripe Dashboard partial refund',
       'A successful partial refund remains a real provider loss')`, [partialRefundAttempt, partialSnapshotId],
  );
  assert.deepEqual(partialDecision.rows[0], { provider_loss_minor: "100", wallet_recovery_minor: "100", uncovered_minor: "0" },
    "successful partial refund is fully reconciled against wallet funds");
  await migration.query("RESET ROLE");
  const partialState = await migration.query<{ attempt_state: string; grant_state: string; reason: string | null }>(
    `select a.state as attempt_state, g.state as grant_state, g.suspension_reason as reason
       from payment_attempt a join access_grant g on g.ledger_entry_id = (
         select l.id from wallet_ledger_entry l where l.operation = 'STRIPE_TOP_UP' and l.idempotency_key = a.id
       ) where a.id = $1`, [partialRefundAttempt],
  );
  assert.deepEqual(partialState.rows[0], { attempt_state: "REVERSED", grant_state: "REVOKED", reason: "STRIPE_REVERSAL" },
    "successful partial refund must not restore access or the reversed payment attempt");
  await migration.query("ROLLBACK");
  transactionOpen = false;
  const remainingFixtures = await migration.query(
    "select count(*)::int as count from auth_user where id = any($1::text[])",
    [[userA, userB, adminA, adminB]],
  );
  assert.equal(remainingFixtures.rows[0]?.count, 0, "the synthetic identity fixtures must be rolled back");

  phase = "checking the runtime database login";
  await runtime.connect();
  const actualRuntime = await runtime.query<{ user: string }>("select current_user as user");
  assert.equal(actualRuntime.rows[0]?.user, "gphkm_runtime", "DATABASE_URL must authenticate as the restricted runtime role");
  await resendWebhook.connect();
  const actualResendRole = await resendWebhook.query<{ user: string }>("select current_user as user");
  assert.equal(actualResendRole.rows[0]?.user, "gphkm_resend_webhook", "RESEND_WEBHOOK_DATABASE_URL must authenticate as the isolated Resend role");
  console.log("Local RLS smoke passed: runtime and Resend role logins, isolated Resend packet delivery and notification callbacks, atomic two-item checkout with exact debit and idempotent replay, trial and URL visibility boundary, cancellation request/replay, work-start/handoff/send-reservation cutoffs, tenant and same-organization membership denial, assigned-Admin decision authorization, exact writing-inclusive refund, decision idempotency, manual handoff evidence/acknowledgement, customer/staff separation, Finance-only reporting, Stripe reconciliation, transfer evidence, metric display gating, and denied direct wallet writes.");
} catch (error) {
  console.error(`Local RLS smoke failed while ${phase}; any open synthetic-data transaction will be rolled back.`);
  if (error instanceof Error) console.error(error.message);
  if (typeof error === "object" && error !== null && "detail" in error && typeof error.detail === "string") console.error(error.detail);
  if (typeof error === "object" && error !== null && "where" in error && typeof error.where === "string") console.error(error.where);
  process.exitCode = 1;
} finally {
  if (transactionOpen) await migration.query("ROLLBACK").catch(() => undefined);
  await migration.end().catch(() => undefined);
  await runtime.end().catch(() => undefined);
  await resendWebhook.end().catch(() => undefined);
}
