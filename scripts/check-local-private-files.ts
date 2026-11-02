import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

function localDatabaseUrl(value: string | undefined, expectedUser: string) {
  if (!value) throw new Error("Private file check requires local database URLs in .env");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Local private file database URL is invalid"); }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !["postgres:", "postgresql:"].includes(url.protocol)
    || decodeURIComponent(url.username) !== expectedUser || url.pathname !== "/gphkm") {
    throw new Error("Private file database check is restricted to the local GPHKM database");
  }
  return value;
}

async function expectSqlState(client: Client, code: string, work: () => Promise<unknown>, inTransaction = false) {
  if (!inTransaction) await client.query("BEGIN");
  await client.query("SAVEPOINT expected_private_file_state");
  try {
    await work();
    assert.fail(`Expected private-file SQLSTATE ${code}`);
  } catch (error) {
    assert.equal(typeof error === "object" && error !== null && "code" in error ? error.code : null, code);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_private_file_state");
    await client.query("RELEASE SAVEPOINT expected_private_file_state");
    if (!inTransaction) await client.query("ROLLBACK");
  }
}

const migration = new Client({ connectionString: localDatabaseUrl(process.env.MIGRATION_DATABASE_URL, "gphkm_migration") });
const runtime = new Client({ connectionString: localDatabaseUrl(process.env.DATABASE_URL, "gphkm_runtime") });
const runtimeQueue = new Client({ connectionString: localDatabaseUrl(process.env.DATABASE_URL, "gphkm_runtime") });
const worker = new Client({ connectionString: localDatabaseUrl(process.env.WORKER_DATABASE_URL, "gphkm_worker") });
const keys: string[] = [];
const batchIds: string[] = [];
let runtimeTransactionOpen = false;
let runtimeQueueTransactionOpen = false;
let phase = "connecting to local restricted roles";

try {
  await Promise.all([migration.connect(), runtime.connect(), runtimeQueue.connect(), worker.connect()]);
  const identities = await Promise.all([
    migration.query<{ user: string }>("select session_user as user"),
    runtime.query<{ user: string }>("select session_user as user"),
    runtimeQueue.query<{ user: string }>("select session_user as user"),
    worker.query<{ user: string }>("select session_user as user"),
  ]);
  assert.deepEqual(identities.map((result) => result.rows[0]?.user), ["gphkm_migration", "gphkm_runtime", "gphkm_runtime", "gphkm_worker"]);

  phase = "checking private-file RLS and command grants";
  const grants = await migration.query<{
    runtime_select: boolean; runtime_register: boolean; runtime_link: boolean; runtime_queue: boolean;
    runtime_claim: boolean; worker_select: boolean; worker_claim: boolean; worker_finish: boolean; worker_register: boolean;
  }>(`select
      has_table_privilege('gphkm_runtime', 'public.private_file_object', 'SELECT') as runtime_select,
      has_function_privilege('gphkm_runtime', 'public.gphkm_register_private_file_upload(text)', 'EXECUTE') as runtime_register,
      has_function_privilege('gphkm_runtime', 'public.gphkm_link_private_file_upload(text)', 'EXECUTE') as runtime_link,
      has_function_privilege('gphkm_runtime', 'public.gphkm_queue_private_file_delete(text)', 'EXECUTE') as runtime_queue,
      has_function_privilege('gphkm_runtime', 'public.gphkm_claim_private_file_deletes(text,integer)', 'EXECUTE') as runtime_claim,
      has_table_privilege('gphkm_worker', 'public.private_file_object', 'SELECT') as worker_select,
      has_function_privilege('gphkm_worker', 'public.gphkm_claim_private_file_deletes(text,integer)', 'EXECUTE') as worker_claim,
      has_function_privilege('gphkm_worker', 'public.gphkm_finish_private_file_delete(text,text,boolean)', 'EXECUTE') as worker_finish,
      has_function_privilege('gphkm_worker', 'public.gphkm_register_private_file_upload(text)', 'EXECUTE') as worker_register`);
  assert.deepEqual(grants.rows[0], {
    runtime_select: false, runtime_register: true, runtime_link: true, runtime_queue: true,
    runtime_claim: false, worker_select: false, worker_claim: true, worker_finish: true, worker_register: false,
  });
  await expectSqlState(runtime, "42501", () => runtime.query("select * from public.private_file_object"));
  await expectSqlState(worker, "42501", () => worker.query("select * from public.private_file_object"));
  await expectSqlState(worker, "42501", () => worker.query("select public.gphkm_register_private_file_upload($1)", [randomUUID()]));
  await expectSqlState(runtime, "42501", () => runtime.query("select * from public.gphkm_claim_private_file_deletes($1,$2)", [randomUUID(), 1]));

  const fixture = await migration.query<{ admin_id: string | null; supplier_id: string | null }>(
    `select (select s.user_id from public.staff_account s where s.active and s.role in ('ADMIN','SUPER_ADMIN') order by s.user_id limit 1) as admin_id,
            (select p.id from public.supplier p order by p.id limit 1) as supplier_id`,
  );
  const adminId = fixture.rows[0]?.admin_id;
  const supplierId = fixture.rows[0]?.supplier_id;
  if (!adminId || !supplierId) throw new Error("A local active Admin and supplier fixture are required for private-file race coverage");

  const workerA = randomUUID();
  const workerB = randomUUID();
  const claim = (workerId: string) => worker.query<{ storage_key: string }>(
    "select * from public.gphkm_claim_private_file_deletes($1,$2)", [workerId, 1],
  );
  const finish = (key: string, workerId: string, succeeded: boolean) => worker.query<{ applied: boolean }>(
    "select public.gphkm_finish_private_file_delete($1,$2,$3) as applied", [key, workerId, succeeded],
  );
  const ageUpload = (key: string) => migration.query(
    `update public.private_file_object set created_at = now() - interval '2 hours', next_attempt_at = '2000-01-01 UTC'
      where storage_key = $1`, [key],
  );

  phase = "claiming a crash-orphaned upload with a lease";
  const orphanKey = randomUUID(); keys.push(orphanKey);
  await runtime.query("select public.gphkm_register_private_file_upload($1)", [orphanKey]);
  await ageUpload(orphanKey);
  const orphanClaim = await claim(workerA);
  assert.equal(orphanClaim.rows[0]?.storage_key, orphanKey);
  await expectSqlState(runtime, "23514", () => runtime.query("select public.gphkm_link_private_file_upload($1)", [orphanKey]));

  phase = "reclaiming an expired lease and rejecting stale worker completion";
  await migration.query("update public.private_file_object set lease_until = now() - interval '1 second' where storage_key = $1", [orphanKey]);
  const reclaimed = await claim(workerB);
  assert.equal(reclaimed.rows[0]?.storage_key, orphanKey);
  assert.equal((await finish(orphanKey, workerA, true)).rows[0]?.applied, false);
  assert.equal((await finish(orphanKey, workerB, false)).rows[0]?.applied, true);
  const retryState = await migration.query<{ state: string; last_error_code: string; next_attempt_at: Date }>(
    "select state, last_error_code, next_attempt_at from public.private_file_object where storage_key = $1", [orphanKey],
  );
  assert.equal(retryState.rows[0]?.state, "DELETE_PENDING");
  assert.equal(retryState.rows[0]?.last_error_code, "STORAGE_DELETE_FAILED");
  assert.ok(new Date(retryState.rows[0]!.next_attempt_at).getTime() > Date.now());
  assert.equal((await claim(workerA)).rows.length, 0, "a failed object delete is not immediately hot-looped");
  await migration.query("update public.private_file_object set next_attempt_at = '2000-01-01 UTC' where storage_key = $1", [orphanKey]);
  assert.equal((await claim(workerA)).rows[0]?.storage_key, orphanKey);
  assert.equal((await finish(orphanKey, workerA, true)).rows[0]?.applied, true);
  const deleted = await migration.query<{ state: string }>("select state from public.private_file_object where storage_key = $1", [orphanKey]);
  assert.equal(deleted.rows[0]?.state, "DELETED");

  phase = "racing a file link against cleanup claim";
  const linkWinsKey = randomUUID(); keys.push(linkWinsKey);
  const linkWinsBatch = randomUUID(); batchIds.push(linkWinsBatch);
  await runtime.query("select public.gphkm_register_private_file_upload($1)", [linkWinsKey]);
  await ageUpload(linkWinsKey);
  await runtime.query("BEGIN");
  runtimeTransactionOpen = true;
  await runtime.query("select set_config('app.user_id', $1, true)", [adminId]);
  await runtime.query(
    `insert into public.catalog_import_batch(id, supplier_id, source_type, source_object_key, source_bytes, content_sha256, mapping, created_by_user_id)
     values ($1, $2, 'CSV', $3, 1, repeat('a', 64), '{}'::jsonb, $4)`,
    [linkWinsBatch, supplierId, linkWinsKey, adminId],
  );
  await runtime.query("select public.gphkm_link_private_file_upload($1)", [linkWinsKey]);
  await expectSqlState(runtime, "23514", () => runtime.query("select public.gphkm_queue_private_file_delete($1)", [linkWinsKey]), true);
  assert.equal((await claim(workerA)).rows.length, 0, "SKIP LOCKED prevents cleanup from racing the uncommitted link");
  await runtime.query("COMMIT");
  runtimeTransactionOpen = false;
  assert.equal((await claim(workerA)).rows.length, 0, "a committed referenced object is not claimable");
  const linkedState = await migration.query<{ state: string }>("select state from public.private_file_object where storage_key = $1", [linkWinsKey]);
  assert.equal(linkedState.rows[0]?.state, "LINKED");

  phase = "racing a delete queue call against a link commit";
  const queueRaceKey = randomUUID(); keys.push(queueRaceKey);
  const queueRaceBatch = randomUUID(); batchIds.push(queueRaceBatch);
  await runtime.query("select public.gphkm_register_private_file_upload($1)", [queueRaceKey]);
  await runtime.query("BEGIN");
  runtimeTransactionOpen = true;
  await runtime.query("select set_config('app.user_id', $1, true)", [adminId]);
  await runtime.query(
    `insert into public.catalog_import_batch(id, supplier_id, source_type, source_object_key, source_bytes, content_sha256, mapping, created_by_user_id)
     values ($1, $2, 'CSV', $3, 1, repeat('c', 64), '{}'::jsonb, $4)`,
    [queueRaceBatch, supplierId, queueRaceKey, adminId],
  );
  await runtime.query("select public.gphkm_link_private_file_upload($1)", [queueRaceKey]);

  await runtimeQueue.query("set application_name = 'gphkm-private-file-queue-race'");
  const queuePid = (await runtimeQueue.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  const queueOutcomePromise = runtimeQueue.query("select public.gphkm_queue_private_file_delete($1)", [queueRaceKey]).then(
    (result) => ({ result, error: null as unknown }),
    (error: unknown) => ({ result: null, error }),
  );

  try {
    const lockWaitDeadline = Date.now() + 5_000;
    let queueIsBlockedOnLink = false;
    while (Date.now() < lockWaitDeadline) {
      const activity = await migration.query<{ wait_event_type: string | null }>(
        "select wait_event_type from pg_stat_activity where pid = $1 and application_name = 'gphkm-private-file-queue-race' and state = 'active'",
        [queuePid],
      );
      if (activity.rows[0]?.wait_event_type === "Lock") {
        queueIsBlockedOnLink = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(queueIsBlockedOnLink, true, "delete queue waits on the lifecycle row locked by the link transaction");

    await runtime.query("COMMIT");
    runtimeTransactionOpen = false;
    const queueOutcome = await queueOutcomePromise;
    assert.equal(typeof queueOutcome.error === "object" && queueOutcome.error !== null && "code" in queueOutcome.error
      ? queueOutcome.error.code : null, "23514", "the delete queue rechecks and rejects the committed reference");
    const queueRaceState = await migration.query<{ state: string }>(
      "select state from public.private_file_object where storage_key = $1", [queueRaceKey],
    );
    assert.equal(queueRaceState.rows[0]?.state, "LINKED", "the referenced object remains linked after the rejected queue call");
    assert.equal((await claim(workerA)).rows.length, 0, "a linked object cannot be claimed for deletion");
  } catch (error) {
    if (runtimeTransactionOpen) {
      await runtime.query("ROLLBACK").catch(() => undefined);
      runtimeTransactionOpen = false;
    }
    await queueOutcomePromise;
    throw error;
  }

  phase = "racing a link against a committed delete queue";
  const queueWinsKey = randomUUID(); keys.push(queueWinsKey);
  const queueWinsBatch = randomUUID(); batchIds.push(queueWinsBatch);
  await runtime.query("select public.gphkm_register_private_file_upload($1)", [queueWinsKey]);
  await runtime.query("BEGIN");
  runtimeTransactionOpen = true;
  await runtime.query("select public.gphkm_queue_private_file_delete($1)", [queueWinsKey]);

  await runtimeQueue.query("BEGIN");
  runtimeQueueTransactionOpen = true;
  await runtimeQueue.query("select set_config('app.user_id', $1, true)", [adminId]);
  await runtimeQueue.query(
    `insert into public.catalog_import_batch(id, supplier_id, source_type, source_object_key, source_bytes, content_sha256, mapping, created_by_user_id)
     values ($1, $2, 'CSV', $3, 1, repeat('d', 64), '{}'::jsonb, $4)`,
    [queueWinsBatch, supplierId, queueWinsKey, adminId],
  );
  await runtimeQueue.query("set application_name = 'gphkm-private-file-queue-race'");
  const queueWinsPid = (await runtimeQueue.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  const blockedLinkOutcomePromise = runtimeQueue.query(
    "select public.gphkm_link_private_file_upload($1)", [queueWinsKey],
  ).then(
    (result) => ({ result, error: null as unknown }),
    (error: unknown) => ({ result: null, error }),
  );

  try {
    const lockWaitDeadline = Date.now() + 5_000;
    let linkIsBlockedOnQueue = false;
    while (Date.now() < lockWaitDeadline) {
      const activity = await migration.query<{ wait_event_type: string | null }>(
        "select wait_event_type from pg_stat_activity where pid = $1 and application_name = 'gphkm-private-file-queue-race' and state = 'active'",
        [queueWinsPid],
      );
      if (activity.rows[0]?.wait_event_type === "Lock") {
        linkIsBlockedOnQueue = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(linkIsBlockedOnQueue, true, "link waits on the lifecycle row locked by the delete queue transaction");

    await runtime.query("COMMIT");
    runtimeTransactionOpen = false;
    const linkOutcome = await blockedLinkOutcomePromise;
    assert.equal(typeof linkOutcome.error === "object" && linkOutcome.error !== null && "code" in linkOutcome.error
      ? linkOutcome.error.code : null, "23514", "the link rejects after the delete intent commits");
    await runtimeQueue.query("ROLLBACK");
    runtimeQueueTransactionOpen = false;

    const rolledBackReference = await migration.query<{ count: string }>(
      "select count(*)::text as count from public.catalog_import_batch where id = $1", [queueWinsBatch],
    );
    assert.equal(rolledBackReference.rows[0]?.count, "0", "the losing reference transaction leaves no business row");
    const queueWinsState = await migration.query<{ state: string }>(
      "select state from public.private_file_object where storage_key = $1", [queueWinsKey],
    );
    assert.equal(queueWinsState.rows[0]?.state, "DELETE_PENDING", "the committed delete intent remains claimable");
    assert.equal((await claim(workerA)).rows[0]?.storage_key, queueWinsKey);
    assert.equal((await finish(queueWinsKey, workerA, true)).rows[0]?.applied, true);
    const queueWinsDeleted = await migration.query<{ state: string }>(
      "select state from public.private_file_object where storage_key = $1", [queueWinsKey],
    );
    assert.equal(queueWinsDeleted.rows[0]?.state, "DELETED", "the delete worker completes the losing upload cleanly");
  } catch (error) {
    if (runtimeTransactionOpen) {
      await runtime.query("ROLLBACK").catch(() => undefined);
      runtimeTransactionOpen = false;
    }
    if (runtimeQueueTransactionOpen) {
      await runtimeQueue.query("ROLLBACK").catch(() => undefined);
      runtimeQueueTransactionOpen = false;
    }
    await blockedLinkOutcomePromise;
    throw error;
  }

  phase = "releasing the linked fixture through the durable queue";
  await migration.query("delete from public.catalog_import_batch where id = $1", [linkWinsBatch]);
  await runtime.query("select public.gphkm_queue_private_file_delete($1)", [linkWinsKey]);
  await migration.query("update public.private_file_object set next_attempt_at = '2000-01-01 UTC' where storage_key = $1", [linkWinsKey]);
  assert.equal((await claim(workerA)).rows[0]?.storage_key, linkWinsKey);
  assert.equal((await finish(linkWinsKey, workerA, true)).rows[0]?.applied, true);

  phase = "rejecting a link after cleanup has already claimed the object";
  const claimWinsKey = randomUUID(); keys.push(claimWinsKey);
  const claimWinsBatch = randomUUID(); batchIds.push(claimWinsBatch);
  await runtime.query("select public.gphkm_register_private_file_upload($1)", [claimWinsKey]);
  await ageUpload(claimWinsKey);
  assert.equal((await claim(workerA)).rows[0]?.storage_key, claimWinsKey);
  await runtime.query("BEGIN");
  runtimeTransactionOpen = true;
  await runtime.query("select set_config('app.user_id', $1, true)", [adminId]);
  await runtime.query("SAVEPOINT losing_link");
  await runtime.query(
    `insert into public.catalog_import_batch(id, supplier_id, source_type, source_object_key, source_bytes, content_sha256, mapping, created_by_user_id)
     values ($1, $2, 'CSV', $3, 1, repeat('b', 64), '{}'::jsonb, $4)`,
    [claimWinsBatch, supplierId, claimWinsKey, adminId],
  );
  await expectSqlState(runtime, "23514", () => runtime.query("select public.gphkm_link_private_file_upload($1)", [claimWinsKey]), true);
  await runtime.query("ROLLBACK TO SAVEPOINT losing_link");
  await runtime.query("COMMIT");
  runtimeTransactionOpen = false;
  const losingReference = await migration.query<{ count: string }>("select count(*)::text as count from public.catalog_import_batch where id = $1", [claimWinsBatch]);
  assert.equal(losingReference.rows[0]?.count, "0", "the business reference rolls back when deletion wins the row lock");
  assert.equal((await finish(claimWinsKey, workerA, true)).rows[0]?.applied, true);

  phase = "queueing a legacy object and confirming idempotent worker deletion";
  const legacyKey = randomUUID(); keys.push(legacyKey);
  await runtime.query("select public.gphkm_queue_private_file_delete($1)", [legacyKey]);
  await migration.query("update public.private_file_object set next_attempt_at = '2000-01-01 UTC' where storage_key = $1", [legacyKey]);
  assert.equal((await claim(workerB)).rows[0]?.storage_key, legacyKey);
  assert.equal((await finish(legacyKey, workerB, true)).rows[0]?.applied, true);

  console.log("Local private-file checks passed: restricted table access, runtime/worker grants, one-hour orphan grace, lease expiry, stale worker rejection, bounded retry, reference-aware deletion, link-vs-claim races in both orders, and queue-vs-link races in both orders.");
} catch (error) {
  console.error(`Local private-file check failed while ${phase}; synthetic data will be cleaned up.`);
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
} finally {
  if (runtimeTransactionOpen) await runtime.query("ROLLBACK").catch(() => undefined);
  if (runtimeQueueTransactionOpen) await runtimeQueue.query("ROLLBACK").catch(() => undefined);
  if (migration.connection) {
    await migration.query("delete from public.catalog_import_batch where id = any($1::text[])", [batchIds]).catch(() => undefined);
    await migration.query("delete from public.private_file_object where storage_key = any($1::text[])", [keys]).catch(() => undefined);
  }
  await Promise.all([migration.end(), runtime.end(), runtimeQueue.end(), worker.end()].map((close) => close.catch(() => undefined)));
}
