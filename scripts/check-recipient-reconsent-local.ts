import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";

const ITEM_ID = randomUUID();
const CURRENT_NOTICE = "gphkm-content-sharing-v1";

function localUrl(value: string | undefined, role: string) {
  if (!value) throw new Error("Recipient re-consent check requires local database URLs from .env");
  const url = new URL(value);
  if (!(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
      || !["postgres:", "postgresql:"].includes(url.protocol)
      || decodeURIComponent(url.username) !== role || url.pathname !== "/gphkm") {
    throw new Error("Recipient re-consent check is restricted to the local GPHKM database and expected role");
  }
  return url;
}

const migrationUrl = localUrl(process.env.MIGRATION_DATABASE_URL, "gphkm_migration");
const runtimeUrl = localUrl(process.env.DATABASE_URL, "gphkm_runtime");
const databaseName = `gphkm_reconsent_${process.pid}_${randomUUID().slice(0, 8)}`;
const isolatedMigrationUrl = new URL(migrationUrl);
const isolatedRuntimeUrl = new URL(runtimeUrl);
isolatedMigrationUrl.pathname = `/${databaseName}`;
isolatedRuntimeUrl.pathname = `/${databaseName}`;
const databaseIdentifier = `"${databaseName}"`;

const administrator = new Client({ connectionString: migrationUrl.href, connectionTimeoutMillis: 5000 });
const setup = new Client({ connectionString: isolatedMigrationUrl.href, connectionTimeoutMillis: 5000 });
const staff = new Client({ connectionString: isolatedRuntimeUrl.href, connectionTimeoutMillis: 5000 });
const customer = new Client({ connectionString: isolatedRuntimeUrl.href, connectionTimeoutMillis: 5000 });
const observer = new Client({ connectionString: isolatedMigrationUrl.href, connectionTimeoutMillis: 5000 });
let created = false;

const uuid = () => randomUUID();
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const sqlState = (error: unknown) => typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;

async function expectRejected(work: () => Promise<unknown>, codes: string[], message: string) {
  let caught: unknown;
  try { await work(); } catch (error) { caught = error; }
  assert.ok(caught, message);
  assert.ok(codes.includes(sqlState(caught) ?? ""), `${message}; got SQLSTATE ${sqlState(caught)}`);
}

async function reconsent(input: {
  actorId: string; ordererId: string; organizationId: string; orderId: string; itemId: string;
  supplierId: string; recipient: string; requestNumber: number; version: number; priorVersion: number;
}) {
  const requestId = uuid();
  const versionId = uuid();
  const createdAt = new Date();
  const approvedAt = new Date(createdAt.getTime() + 2);
  const content = {
    targetUrl: "https://customer.example/article",
    anchorText: "Customer anchor",
    articleText: "Synthetic article used only by this isolated database regression.",
    instructions: "",
  };
  const contentHash = sha256({ ...content, supplierId: input.supplierId, recipientEmail: input.recipient });

  await staff.query("begin");
  try {
    await staff.query("select set_config('app.user_id',$1,true), set_config('app.staff_role','SUPER_ADMIN',true), set_config('app.organization_id','',true)", [input.actorId]);
    await staff.query("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0::bigint))",
      [`supplier_packet_prepare:${input.orderId}`]);
    await staff.query("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0::bigint))",
      [`gphkm:supplier-contact:${input.supplierId}`]);
    await staff.query("select 1 from public.order_item_fulfillment where order_item_id=$1 for update", [input.itemId]);
    await staff.query(
      `insert into public.order_item_content_change_request
        (id,order_item_id,request_number,requested_by_user_id,base_version,purpose,target_supplier_id,target_url,anchor_text,article_text,instructions,created_at)
       values ($1,$2,$3,$4,$5,'RECIPIENT_RECONSENT',$6,$7,$8,$9,nullif($10,''),$11)`,
      [requestId, input.itemId, input.requestNumber, input.ordererId, input.priorVersion, input.supplierId,
        content.targetUrl, content.anchorText, content.articleText, content.instructions, createdAt],
    );
    await staff.query(
      `insert into public.order_item_content_version
        (id,order_item_id,request_id,version,target_url,anchor_text,article_text,instructions,supplier_id,recipient_email,content_hash,approved_by_user_id,approved_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [versionId, input.itemId, requestId, input.version, content.targetUrl, content.anchorText, content.articleText,
        content.instructions, input.supplierId, input.recipient, contentHash, input.actorId, approvedAt],
    );
    await staff.query(
      `insert into public.order_item_content_change_event
        (id,request_id,actor_user_id,event_type,version_id,content_hash,notice_version,created_at)
       values ($1,$3,$5,'REQUESTED',null,null,null,$6),($2,$3,$5,'APPROVED',$4,$7,null,$8)`,
      [uuid(), uuid(), requestId, versionId, input.actorId, createdAt, contentHash, approvedAt],
    );
    await staff.query(
      `insert into public.audit_event (id,organization_id,actor_user_id,action,target_type,target_id,reason_code,metadata)
       values ($1,$2,$3,'SUPPLIER_RECIPIENT_RECONSENT_REQUESTED','CUSTOMER_ORDER_ITEM',$4,'CONFIRMED_NOT_DELIVERED',
         jsonb_build_object('result','ORDERER_ACTION_REQUIRED','version',$5::integer))`,
      [uuid(), input.organizationId, input.actorId, input.itemId, input.version],
    );
    await staff.query("commit");
  } catch (error) {
    await staff.query("rollback").catch(() => undefined);
    throw error;
  }
  return { requestId, versionId, contentHash, content };
}

async function waitUntilBlocked(blockedPid: number) {
  for (let i = 0; i < 200; i += 1) {
    const result = await observer.query<{ blocked: boolean }>(
      `select exists(select 1 from pg_stat_activity where pid=$1 and state='active' and wait_event_type='Lock') as blocked`, [blockedPid]);
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const activity = await observer.query("select state,wait_event_type,wait_event from pg_stat_activity where pid=$1", [blockedPid]);
  throw new Error(`Customer consent did not wait on supplier contact lock: ${JSON.stringify(activity.rows[0] ?? null)}`);
}

try {
  await administrator.connect();
  const exists = await administrator.query("select exists(select 1 from pg_database where datname=$1) as exists", [databaseName]);
  assert.equal(exists.rows[0]?.exists, false);
  await administrator.query(`create database ${databaseIdentifier} owner gphkm_migration template template0`);
  created = true;
  const pool = new Pool({ connectionString: isolatedMigrationUrl.href, connectionTimeoutMillis: 5000, max: 1 });
  try { await migrate(drizzle(pool), { migrationsFolder: "./src/db/migrations" }); }
  finally { await pool.end(); }
  await Promise.all([setup.connect(), staff.connect(), customer.connect(), observer.connect()]);

  const ownerId = uuid();
  const otherCustomerId = uuid();
  const superAdminId = uuid();
  const organizationId = uuid();
  const orderId = uuid();
  const supplierId = uuid();
  const listingId = uuid();
  const packetId = `pkt_${uuid()}`;
  const failedAttemptId = uuid();
  const oldRecipient = "old@reconsent.invalid";
  const currentRecipient = "current@reconsent.invalid";
  const racedRecipient = "raced@reconsent.invalid";
  const oldContentHash = "b".repeat(64);
  const handoffAt = new Date();
  const targetUrl = "https://customer.example/article";
  const anchorText = "Customer anchor";
  const articleText = "Synthetic article used only by this isolated database regression.";
  await setup.query("begin");
  await setup.query(
    `insert into public.auth_user (id,name,email,email_verified) values
      ($1,'Re-consent owner',$2,true),($3,'Non-orderer',$4,true),($5,'Re-consent Super Admin',$6,true)`,
    [ownerId, `${ownerId}@reconsent.invalid`, otherCustomerId, `${otherCustomerId}@reconsent.invalid`, superAdminId, `${superAdminId}@reconsent.invalid`],
  );
  await setup.query("insert into public.staff_account (user_id,role,active) values ($1,'SUPER_ADMIN',true)", [superAdminId]);
  await setup.query("insert into public.organization (id,name,created_by) values ($1,'Re-consent fixture',$2)", [organizationId, ownerId]);
  await setup.query("insert into public.organization_member (id,organization_id,user_id,role,active) values ($1,$2,$3,'OWNER',true)", [uuid(), organizationId, ownerId]);
  await setup.query("insert into public.wallet_account (organization_id,currency) values ($1,'USD')", [organizationId]);
  await setup.query(
    `insert into public.wallet_ledger_entry (id,organization_id,actor_user_id,kind,delta_minor,currency,operation,idempotency_key)
     values ($1,$2,$3,'TOP_UP',5000,'USD','RECONSENT_FIXTURE_TOP_UP',$4)`, [uuid(), organizationId, ownerId, `reconsent-credit-${orderId}`],
  );
  await setup.query("insert into public.supplier (id,name,status,created_by_user_id) values ($1,'Re-consent supplier','ACTIVE',$2)", [supplierId, superAdminId]);
  await setup.query("insert into public.supplier_contact (id,supplier_id,name,email,is_primary) values ($1,$2,'Primary contact',$3,true)", [uuid(), supplierId, oldRecipient]);
  await setup.query("alter table public.customer_order disable trigger user");
  await setup.query(
    `insert into public.customer_order (id,organization_id,actor_user_id,idempotency_key,request_hash,
       placement_total_minor,writing_total_minor,total_minor,content_sharing_notice_version,content_policy_version,
       content_policy_accepted_at,customer_status,checkout_state)
     values ($1,$2,$3,$4,$5,1000,0,1000,$6,'gphkm-content-policy-v1',clock_timestamp(),'PREPARING','PENDING_POST')`,
    [orderId, organizationId, ownerId, `reconsent-${orderId}`, "c".repeat(64), CURRENT_NOTICE],
  );
  await setup.query("alter table public.customer_order enable trigger user");
  const debitId = uuid();
  await setup.query(
    `insert into public.wallet_ledger_entry (id,organization_id,actor_user_id,kind,delta_minor,currency,operation,idempotency_key,related_type,related_id,reason_code)
     values ($1,$2,$3,'ORDER_DEBIT',-1000,'USD',$4,$5,'CUSTOMER_ORDER',$6,'ORDER_CHECKOUT')`,
    [debitId, organizationId, ownerId, `RECONSENT_FIXTURE:${orderId}`, `reconsent-debit-${orderId}`, orderId],
  );
  await setup.query("update public.customer_order set checkout_state='PAID',paid_ledger_entry_id=$2 where id=$1", [orderId, debitId]);
  await setup.query(
    `insert into public.marketplace_listing (id,title,description,country_code,primary_language,categories,
       retail_price_cents,link_type,link_validity,turnaround_days,sponsored_content_marking,status,
       allows_sports_and_gaming,allows_pharmacy,allows_crypto,allows_foreign_language)
     values ($1,'Re-consent listing','Synthetic fixture','US','English',ARRAY['General'],1000,'DOFOLLOW','PERMANENT',30,false,'DRAFT',false,false,false,false)`, [listingId],
  );
  await setup.query("alter table public.customer_order_item disable trigger user");
  await setup.query("alter table public.order_item_fulfillment disable trigger user");
  await setup.query("alter table public.order_item_fulfillment_supplier disable trigger user");
  await setup.query(
    `insert into public.customer_order_item (id,order_id,listing_id,listing_revision,customer_listing_snapshot,
       placement_price_minor,writing_selected,target_url,anchor_text,article_text,supplier_sharing_consented,consent_notice_version)
     values ($1,$2,$3,1,jsonb_build_object('title','Re-consent listing'),1000,false,$4,$5,$6,true,$7)`,
    [ITEM_ID, orderId, listingId, targetUrl, anchorText, articleText, CURRENT_NOTICE],
  );
  await setup.query(
    "insert into public.order_item_financial (order_item_id,commercial_source,supplier_id,fulfillment_supplier_id) values ($1,'SUPPLIER_SOURCED',$2,$2)",
    [ITEM_ID, supplierId],
  );
  await setup.query("update public.order_item_fulfillment set state='READY_FOR_HANDOFF',assigned_admin_id=$2 where order_item_id=$1", [ITEM_ID, superAdminId]);
  await setup.query("alter table public.order_item_fulfillment_supplier enable trigger user");
  await setup.query("alter table public.order_item_fulfillment enable trigger user");
  await setup.query("alter table public.customer_order_item enable trigger user");
  await setup.query(
    `insert into public.order_item_supplier_consent (order_item_id,supplier_id,recipient_email,notice_version,accepted_at,capture_source)
     values ($1,$2,$3,$4,(select consented_at from public.customer_order_item where id=$1),'CHECKOUT_ROUTE')`,
    [ITEM_ID, supplierId, oldRecipient, CURRENT_NOTICE],
  );
  await setup.query(
    `insert into public.supplier_packet (id,version,organization_id,order_id,supplier_id,recipient,packet,content_hash,created_by_user_id)
     select $1,1,$2,$3,$4,$5,jsonb_build_object(
       'id',$1::text,'version',1,'organizationId',$2::text,'orderId',$3::text,'supplierId',$4::text,'recipient',$5::text,
       'createdBy',$6::text,'createdAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
       'contentHash',$7::text,'items',jsonb_build_array(jsonb_build_object(
         'orderItemId',$8::text,'assignedAdminId',$6::text,'placementRequirements',jsonb_build_array('Follow the agreed publication requirements.'),
         'targetUrl',$9::text,'anchorText',$10::text,'article',$11::text,'instructions','',
         'consent',jsonb_build_object('disclosureVersion',$12::text,'contentHash',$7::text,'supplierId',$4::text,
           'recipient',lower(btrim($5::text)),'consentEventId',null,
           'acceptedAt',to_char(item.consented_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
       )),$7,$6
       from public.customer_order_item item where item.id=$8`,
    [packetId, organizationId, orderId, supplierId, oldRecipient, superAdminId, oldContentHash, ITEM_ID, targetUrl, anchorText, articleText, CURRENT_NOTICE],
  );
  await setup.query(
    `insert into public.supplier_packet_item (packet_id,order_item_id,assigned_admin_id,consent_notice_version,consented_at,consent_content_hash,route_generation)
     select $1,item.id,$2,item.consent_notice_version,item.consented_at,$3,route.route_generation
       from public.customer_order_item item join public.order_item_fulfillment_supplier route on route.order_item_id=item.id where item.id=$4`,
    [packetId, superAdminId, oldContentHash, ITEM_ID],
  );
  await setup.query("alter table public.order_item_fulfillment disable trigger user");
  await setup.query("update public.order_item_fulfillment set state='HANDOFF_PENDING',handed_off_at=$2,work_started_at=null where order_item_id=$1", [ITEM_ID, handoffAt]);
  await setup.query("alter table public.order_item_fulfillment enable trigger user");
  // This historical attempt is a synthetic, fixture-only representation of a
  // verified Resend delivery issue that staff reconciled as not delivered.
  await setup.query("alter table public.supplier_packet_attempt disable trigger user");
  await setup.query("alter table public.supplier_packet_attempt_event disable trigger user");
  await setup.query(
    `insert into public.supplier_packet_attempt (id,packet_id,type,state,actor_user_id,recipient,idempotency_key,provider,provider_reference,accepted_at,resolved_at)
     values ($1,$2,'SEND','RECONCILED_FAILED',$3,$4,$5,'RESEND','reconsent-fixture-message',$6,$6)`,
    [failedAttemptId, packetId, superAdminId, oldRecipient, `failed-${failedAttemptId}`, handoffAt],
  );
  await setup.query(
    `insert into public.supplier_packet_attempt_event (id,attempt_id,actor_user_id,actor_kind,from_state,to_state,reason_code,created_at)
     values ($1,$2,$3,'STAFF','DELIVERY_ISSUE','RECONCILED_FAILED','DELIVERY_ISSUE_CONFIRMED_NOT_DELIVERED',$4)`,
    [uuid(), failedAttemptId, superAdminId, handoffAt],
  );
  await setup.query("alter table public.supplier_packet_attempt_event enable trigger user");
  await setup.query("alter table public.supplier_packet_attempt enable trigger user");
  await setup.query("update public.supplier_contact set email=$2 where supplier_id=$1 and is_primary", [supplierId, currentRecipient]);
  await setup.query("commit");

  await Promise.all([staff.query("select set_config('app.user_id',$1,false),set_config('app.staff_role','SUPER_ADMIN',false)", [superAdminId]),
    customer.query("select set_config('app.user_id',$1,false),set_config('app.organization_id',$2,false)", [ownerId, organizationId])]);
  const eligible = await staff.query("select public.gphkm_supplier_packet_retry_eligible($1,null) as eligible", [ITEM_ID]);
  assert.equal(eligible.rows[0]?.eligible, true, "only a reconciled, accepted, explicitly not-delivered attempt opens the recovery gate");

  const hiddenRoute = await customer.query("select count(*)::int as count from public.order_item_fulfillment_supplier where order_item_id=$1", [ITEM_ID]);
  assert.equal(hiddenRoute.rows[0]?.count, 0, "customer RLS must continue to hide internal supplier routing");

  const first = await reconsent({ actorId: superAdminId, ordererId: ownerId, organizationId, orderId, itemId: ITEM_ID,
    supplierId, recipient: currentRecipient, requestNumber: 1, version: 2, priorVersion: 1 });
  await customer.query("begin");
  await customer.query("select public.gphkm_lock_customer_recipient_reconsent($1)", [first.requestId]);
  await customer.query("commit");
  const pendingProjection = await customer.query(
    "select count(*)::int as count from public.gphkm_customer_approved_content($1,$2,$3)", [first.requestId, ownerId, organizationId]);
  assert.equal(pendingProjection.rows[0]?.count, 1, "orderer sees exact approved re-consent content before consent");

  const projectionPool = new Pool({ connectionString: isolatedRuntimeUrl.href, connectionTimeoutMillis: 5000, max: 1 });
  try {
    const projectionDb = drizzle({ client: projectionPool });
    const pageProjection = await projectionDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${ownerId}, true)`);
      await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
      const requestIds = [first.requestId, uuid()];
      return tx.execute(sql`select request.id as request_id, approved.version
        from public.order_item_content_change_request request
        left join lateral public.gphkm_customer_approved_content(request.id, ${ownerId}, ${organizationId}) approved on true
        where request.id in (${sql.join(requestIds.map((requestId) => sql`${requestId}`), sql`, `)})`);
    });
    assert.equal(pageProjection.rows.length, 1, "batched customer projection binds each request ID safely");
    assert.equal(pageProjection.rows[0]?.version, 2, "the orderer receives the pending approved content version");
  } finally {
    await projectionPool.end();
  }

  await customer.query("begin");
  await customer.query("savepoint wrong_actor");
  await customer.query("select set_config('app.user_id',$1,true),set_config('app.organization_id',$2,true)", [superAdminId, organizationId]);
  await customer.query("savepoint wrong_actor_lock");
  await expectRejected(() => customer.query(
    "select public.gphkm_lock_customer_recipient_reconsent($1)", [first.requestId]),
    ["42501"], "the lock helper must reject a caller who is not the orderer");
  await customer.query("rollback to savepoint wrong_actor_lock");
  await customer.query("release savepoint wrong_actor_lock");
  await expectRejected(() => customer.query(
    `insert into public.order_item_content_change_event (id,request_id,actor_user_id,event_type,version_id,content_hash,notice_version)
     values ($1,$2,$3,'CONSENTED',$4,$5,$6)`, [uuid(), first.requestId, superAdminId, first.versionId, first.contentHash, CURRENT_NOTICE]),
    ["23514", "42501"], "a non-orderer must not consent to sharing");
  await customer.query("rollback to savepoint wrong_actor");
  await customer.query("release savepoint wrong_actor");
  await customer.query("rollback");

  // A contact edit that wins the shared supplier advisory lock must invalidate
  // a customer consent which was queued for the previous recipient.
  await setup.query("begin");
  await setup.query("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0::bigint))",
    [`gphkm:supplier-contact:${supplierId}`]);
  const customerPidResult = await customer.query("select pg_backend_pid() as pid");
  const customerPid = Number(customerPidResult.rows[0]?.pid);
  const pendingConsent = customer.query("begin")
    .then(() => customer.query("select set_config('app.user_id',$1,true),set_config('app.organization_id',$2,true)", [ownerId, organizationId]))
    .then(() => customer.query("select public.gphkm_lock_customer_recipient_reconsent($1)", [first.requestId]))
    .then(() => customer.query(
      "insert into public.order_item_content_change_event (id,request_id,actor_user_id,event_type,version_id,content_hash,notice_version) values ($1,$2,$3,'CONSENTED',$4,$5,$6)",
      [uuid(), first.requestId, ownerId, first.versionId, first.contentHash, CURRENT_NOTICE],
    ));
  await waitUntilBlocked(customerPid);
  await setup.query("update public.supplier_contact set email=$2 where supplier_id=$1 and is_primary", [supplierId, racedRecipient]);
  await setup.query("commit");
  await expectRejected(() => pendingConsent, ["23514"], "consent must fail if the recipient changes while it waits on the supplier lock");
  await customer.query("rollback").catch(() => undefined);

  const staleProjection = await customer.query(
    "select count(*)::int as count from public.gphkm_customer_approved_content($1,$2,$3)", [first.requestId, ownerId, organizationId]);
  assert.equal(staleProjection.rows[0]?.count, 0, "a superseded recipient approval is hidden from the customer projection");
  await staff.query("begin");
  await staff.query("select set_config('app.user_id',$1,true),set_config('app.staff_role','SUPER_ADMIN',true)", [superAdminId]);
  await staff.query("savepoint stale_packet_retry");
  const stalePacketAttempt = uuid();
  await expectRejected(() => staff.query(
    `insert into public.supplier_packet_attempt (id,packet_id,type,state,actor_user_id,recipient,idempotency_key,provider)
     values ($1,$2,'SEND','SENDING',$3,$4,$5,'RESEND')`,
    [stalePacketAttempt, packetId, superAdminId, oldRecipient, `stale-${stalePacketAttempt}`]),
    ["42501"], "a packet addressed to the previous contact cannot be retried after recipient drift");
  await staff.query("rollback to savepoint stale_packet_retry");
  await staff.query("release savepoint stale_packet_retry");
  await staff.query("commit");
  const second = await reconsent({ actorId: superAdminId, ordererId: ownerId, organizationId, orderId, itemId: ITEM_ID,
    supplierId, recipient: racedRecipient, requestNumber: 2, version: 3, priorVersion: 2 });

  await customer.query("begin");
  await customer.query("select set_config('app.user_id',$1,true),set_config('app.organization_id',$2,true)", [ownerId, organizationId]);
  await customer.query("savepoint wrong_notice_version");
  await expectRejected(() => customer.query(
    `insert into public.order_item_content_change_event (id,request_id,actor_user_id,event_type,version_id,content_hash,notice_version)
     values ($1,$2,$3,'CONSENTED',$4,$5,'obsolete-disclosure-v0')`,
    [uuid(), second.requestId, ownerId, second.versionId, second.contentHash]),
    ["23514"], "database consent guard must reject a non-current supplier sharing notice version");
  await customer.query("rollback to savepoint wrong_notice_version");
  await customer.query("release savepoint wrong_notice_version");
  await customer.query("commit");

  const consentedAt = new Date();
  const consentEventId = uuid();
  const replacementPacketId = `pkt_${uuid()}`;
  const acceptedAt = await staff.query<{ accepted_at: string }>(
    "select to_char($1::timestamptz at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as accepted_at", [consentedAt]);
  const packet = {
    id: replacementPacketId, version: 2, organizationId, orderId, supplierId, recipient: racedRecipient,
    createdBy: superAdminId, createdAt: new Date().toISOString(), contentHash: second.contentHash,
    items: [{ orderItemId: ITEM_ID, assignedAdminId: superAdminId,
      placementRequirements: ["Follow the agreed publication requirements."], targetUrl: second.content.targetUrl,
      anchorText: second.content.anchorText, article: second.content.articleText, instructions: "",
      consent: { disclosureVersion: CURRENT_NOTICE, contentHash: second.contentHash, supplierId, recipient: racedRecipient,
        consentEventId, acceptedAt: acceptedAt.rows[0]!.accepted_at } }],
  };

  await staff.query("begin");
  await staff.query("select set_config('app.user_id',$1,true),set_config('app.staff_role','SUPER_ADMIN',true)", [superAdminId]);
  await staff.query(
    `insert into public.supplier_packet (id,version,organization_id,order_id,supplier_id,recipient,packet,content_hash,created_by_user_id)
     values ($1,2,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [replacementPacketId, organizationId, orderId, supplierId, racedRecipient, JSON.stringify(packet), second.contentHash, superAdminId],
  );
  await staff.query("savepoint pending_orderer_review");
  await expectRejected(() => staff.query(
    `insert into public.supplier_packet_item (packet_id,order_item_id,assigned_admin_id,consent_notice_version,consented_at,consent_content_hash,route_generation)
     values ($1,$2,$3,$4,$5::timestamptz,$6,1)`,
    [replacementPacketId, ITEM_ID, superAdminId, CURRENT_NOTICE, acceptedAt.rows[0]!.accepted_at, second.contentHash]),
    ["23514"], "the latest APPROVED review must continue to block packet preparation until the orderer consents");
  await staff.query("rollback to savepoint pending_orderer_review");
  await staff.query("release savepoint pending_orderer_review");

  await staff.query("select set_config('app.user_id',$1,true),set_config('app.organization_id',$2,true),set_config('app.staff_role','',true)", [ownerId, organizationId]);
  await staff.query(
    `insert into public.order_item_content_change_event (id,request_id,actor_user_id,event_type,version_id,content_hash,notice_version,created_at)
     values ($1,$2,$3,'CONSENTED',$4,$5,$6,$7)`, [consentEventId, second.requestId, ownerId, second.versionId, second.contentHash, CURRENT_NOTICE, consentedAt]);
  await staff.query("select set_config('app.user_id',$1,true),set_config('app.organization_id','',true),set_config('app.staff_role','SUPER_ADMIN',true)", [superAdminId]);
  await staff.query(
    `insert into public.supplier_packet_item (packet_id,order_item_id,assigned_admin_id,consent_notice_version,consented_at,consent_content_hash,route_generation)
     values ($1,$2,$3,$4,$5::timestamptz,$6,1)`,
    [replacementPacketId, ITEM_ID, superAdminId, CURRENT_NOTICE, acceptedAt.rows[0]!.accepted_at, second.contentHash],
  );
  const attemptId = uuid();
  await staff.query(
    `insert into public.supplier_packet_attempt (id,packet_id,type,state,actor_user_id,recipient,idempotency_key,resend_reason,provider)
     values ($1,$2,'SEND','SENDING',$3,$4,$5,'Retry after confirmed non-delivery','RESEND')`,
    [attemptId, replacementPacketId, superAdminId, racedRecipient, `send-${attemptId}`],
  );
  await staff.query("savepoint export_denied");
  await expectRejected(() => staff.query(
    `insert into public.supplier_packet_attempt (id,packet_id,type,state,actor_user_id,recipient,idempotency_key,provider)
     values ($1,$2,'EML_EXPORT','EXPORTED',$3,$4,$5,null)`, [uuid(), replacementPacketId, superAdminId, racedRecipient, `export-${uuid()}`]),
    ["42501"], "post-cutoff same-supplier retry is Resend-only");
  await staff.query("rollback to savepoint export_denied");
  await staff.query("release savepoint export_denied");
  await staff.query("commit");

  const audit = await staff.query(
    "select count(*)::int as count from public.audit_event where target_id=$1 and action='SUPPLIER_RECIPIENT_RECONSENT_REQUESTED'", [ITEM_ID]);
  assert.equal(audit.rows[0]?.count, 2, "each Super Admin re-consent request is audited, including a replacement after recipient drift");
  const cutoff = await setup.query<{ unchanged: boolean }>(
    `select fulfillment.handed_off_at=$2::timestamptz and fulfillment.state='HANDOFF_PENDING'
        and fulfillment.work_started_at is null and order_row.customer_status='PREPARING' as unchanged
       from public.order_item_fulfillment fulfillment
       join public.customer_order_item item on item.id=fulfillment.order_item_id
       join public.customer_order order_row on order_row.id=item.order_id
      where fulfillment.order_item_id=$1`,
    [ITEM_ID, handoffAt]);
  assert.equal(cutoff.rows[0]?.unchanged, true, "re-consent and replacement packet reservation do not reset the handoff cutoff or start publication work");

  console.log("Local recipient re-consent regression passed: reconciled-not-delivered eligibility, Super Admin audit, orderer-only exact-recipient consent, stale recipient lock race, canonical disclosure-version enforcement, replacement packet validation, Resend-only post-cutoff retry, and unchanged Preparing cutoff.");
} finally {
  await Promise.all([setup.end().catch(() => undefined), staff.end().catch(() => undefined), customer.end().catch(() => undefined),
    observer.end().catch(() => undefined)]);
  if (created) {
    await administrator.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1", [databaseName]).catch(() => undefined);
    await administrator.query(`drop database if exists ${databaseIdentifier} with (force)`).catch((error: unknown) => {
      console.error(`Could not drop isolated recipient re-consent database ${databaseName}: ${String(error)}`);
      process.exitCode = 1;
    });
  }
  await administrator.end().catch(() => undefined);
}
