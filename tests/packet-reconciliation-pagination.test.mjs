import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { staffCatalogPagination } from "../src/modules/catalog/pagination.ts";

test("packet reconciliation pages every issue queue with stable bounds", async () => {
  const page = staffCatalogPagination("6", 251);
  assert.deepEqual({ page: page.page, totalPages: page.totalPages, offset: page.offset, limit: page.limit }, {
    page: 6, totalPages: 6, offset: 250, limit: 50,
  });

  const service = await readFile(new URL("../src/server/fulfillment/packets.ts", import.meta.url), "utf8");
  assert.match(service, /async function clearResolvedPacketSizeHold/);
  assert.match(service, /action: "SUPPLIER_PACKET_SIZE_HOLD_CLEARED"/);
  assert.match(service, /reasonCode: "REVIEWED_WITHIN_LIMIT"/);
  assert.match(service, /clearResolvedPacketSizeHold\(tx, row, actor\.userId\)/g);
  assert.match(service, /holdReason: row\.holdReason, heldAt: row\.heldAt/);
  const queue = service.slice(service.indexOf("export async function listSupplierPacketReconciliation"), service.indexOf("export async function processResendWebhook"));
  assert.match(queue, /staffCatalogPagination\(requestedPages\.attempts/);
  assert.match(queue, /staffCatalogPagination\(requestedPages\.events/);
  assert.match(queue, /staffCatalogPagination\(requestedPages\.items/);
  assert.match(queue, /staffCatalogPagination\(requestedPages\.held/);
  assert.match(queue, /limit\(attemptsPagination\.limit\)\.offset\(attemptsPagination\.offset\)/);
  assert.match(queue, /limit\(unpacketItemsPagination\.limit\)\.offset\(unpacketItemsPagination\.offset\)/);
  assert.match(queue, /limit\(heldPacketsPagination\.limit\)\.offset\(heldPacketsPagination\.offset\)/);
  assert.match(queue, /limit\(unmatchedEventsPagination\.limit\)\.offset\(unmatchedEventsPagination\.offset\)/);
  assert.match(queue, /actor\.role === "ADMIN" \? and\(assignedPacketExists, assignedPacketHasNoReassignedItems\)/);
  assert.match(queue, /const heldWhere = and\([\s\S]*actor\.role === "ADMIN" \? and\(assignedPacketExists, assignedPacketHasNoReassignedItems\)/);
  assert.match(queue, /\.from\(supplierPacket\)\.where\(heldWhere\);[\s\S]*\.from\(supplierPacket\)\.where\(heldWhere\)\.orderBy/);
  assert.doesNotMatch(queue, /heldPacketRows\.filter/);
  assert.match(queue, /const eventAssignedPacketExists = exists\([\s\S]*\.innerJoin\(orderItemFulfillment, eq\(orderItemFulfillment\.orderItemId, supplierPacketItem\.orderItemId\)\)[\s\S]*eq\(orderItemFulfillment\.assignedAdminId, actor\.userId\)/);
  assert.match(queue, /const eventPacketHasNoReassignedItems = notExists\([\s\S]*assignedAdminId\} is distinct from \$\{actor\.userId\}/);
  assert.match(queue, /eventAssignedPacketExists, eventPacketHasNoReassignedItems/);
  assert.match(queue, /\.from\(supplierPacketProviderEvent\)\.where\(eventWhere\);[\s\S]*\.where\(eventWhere\)\.orderBy/);
  assert.match(queue, /const actionableAttempt = sql`[\s\S]*supplierPacket\.supersededAt} IS NULL/);
  assert.match(queue, /\.from\(supplierPacketAttempt\)[\s\S]*\.where\(attemptsWhere\);[\s\S]*\.from\(supplierPacketAttempt\)[\s\S]*\.where\(attemptsWhere\)\.orderBy/);
  assert.match(queue, /newer_export\.created_at, newer_export\.id/);
  assert.match(queue, /pending_manual\.state = 'SENDING'/);
  assert.doesNotMatch(queue, /const relevant = attempts\.flatMap/);
  assert.doesNotMatch(queue, /if \(actor\.role === "ADMIN" && \(!items\.length/);
  assert.match(queue, /actor\.role === "SUPER_ADMIN" \? eq\(supplierPacketProviderEvent\.state/);
  assert.doesNotMatch(queue, /\.limit\((?:100|200)\)/);

  const pageSource = await readFile(new URL("../src/app/staff/(console)/fulfillment/packets/reconciliation/page.tsx", import.meta.url), "utf8");
  assert.match(pageSource, /Packet attempt pages/);
  assert.match(pageSource, /Provider event pages/);
  assert.match(pageSource, /Unpacket item pages/);
  assert.match(pageSource, /Held packet pages/);
  const detailPage = await readFile(new URL("../src/app/staff/(console)/fulfillment/packets/[packetId]/page.tsx", import.meta.url), "utf8");
  assert.match(detailPage, /data\.holdReason === "PACKET_SIZE_REVIEW"/);
  assert.match(detailPage, /successful under-limit action clears this hold and records the review/);
});
