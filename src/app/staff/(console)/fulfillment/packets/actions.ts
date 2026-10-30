"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { beginManualSupplierHandoff, markStuckSupplierPacketUnknown, prepareSupplierPackets, recordSupplierAcknowledgement, reconcileManualSupplierHandoffUnsent, reconcileSupplierPacketAttempt, sendSupplierPacket } from "@/server/fulfillment/packets";

function get(form: FormData, key: string) { const value = form.get(key); return typeof value === "string" ? value.trim() : ""; }

export async function preparePacketsAction(form: FormData) {
  const orderId = get(form, "orderId");
  const itemIds = form.getAll("itemIds").filter((value): value is string => typeof value === "string");
  let packetIds: string[];
  try { packetIds = await prepareSupplierPackets(await headers(), orderId, itemIds); }
  catch { redirect(`/staff/fulfillment/packets/new?orderId=${encodeURIComponent(orderId)}&error=prepare`); }
  if (!packetIds.length) redirect(`/staff/fulfillment/packets/new?orderId=${encodeURIComponent(orderId)}&error=empty`);
  const preparedIds = encodeURIComponent(packetIds.join(","));
  redirect(`/staff/fulfillment/packets/${encodeURIComponent(packetIds[0])}?preparedIds=${preparedIds}`);
}

export async function sendSupplierPacketAction(form: FormData) {
  const packetId = get(form, "packetId");
  try { await sendSupplierPacket(await headers(), packetId, get(form, "resendReason"), get(form, "attachPdf") === "on"); }
  catch { redirect(`/staff/fulfillment/packets/${encodeURIComponent(packetId)}?error=send`); }
  redirect(`/staff/fulfillment/packets/${encodeURIComponent(packetId)}?sent=1`);
}

export async function beginManualHandoffAction(form: FormData) {
  const packetId = get(form, "packetId");
  try { await beginManualSupplierHandoff(await headers(), packetId, get(form, "resendReason")); }
  catch { redirect(`/staff/fulfillment/packets/${encodeURIComponent(packetId)}?error=manual-begin`); }
  redirect(`/staff/fulfillment/packets/${encodeURIComponent(packetId)}?manual=pending`);
}

export async function reconcileManualHandoffUnsentAction(form: FormData) {
  const packetId = get(form, "packetId");
  if (get(form, "confirmNotSent") !== "on") redirect(`/staff/fulfillment/packets/${encodeURIComponent(packetId)}?error=manual-reconcile`);
  try { await reconcileManualSupplierHandoffUnsent(await headers(), { packetId, attemptId: get(form, "attemptId"), reason: get(form, "reason") }); }
  catch { redirect(`/staff/fulfillment/packets/${encodeURIComponent(packetId)}?error=manual-reconcile`); }
  redirect(`/staff/fulfillment/packets/${encodeURIComponent(packetId)}?manual=unsent`);
}

export async function recordSupplierAcknowledgementAction(form: FormData) {
  const packetId = get(form, "packetId");
  try { await recordSupplierAcknowledgement(await headers(), { packetId, attemptId: get(form, "attemptId"), reference: get(form, "reference") }); }
  catch { redirect(`/staff/fulfillment/packets/${encodeURIComponent(packetId)}?error=acknowledgement`); }
  redirect(`/staff/fulfillment/packets/${encodeURIComponent(packetId)}?acknowledged=1`);
}

export async function reconcilePacketAttemptAction(form: FormData) {
  const packetId = get(form, "packetId");
  try { await reconcileSupplierPacketAttempt(await headers(), { attemptId: get(form, "attemptId"), outcome: get(form, "outcome") as "ACCEPTED" | "DELIVERY_ISSUE" | "RECONCILED_FAILED", providerReference: get(form, "providerReference"), acceptedAt: get(form, "acceptedAt"), reason: get(form, "reason") }); }
  catch { redirect(`/staff/fulfillment/packets/${encodeURIComponent(packetId)}?error=reconcile`); }
  redirect(`/staff/fulfillment/packets/${encodeURIComponent(packetId)}?reconciled=1`);
}

export async function markStuckAttemptUnknownAction(form: FormData) {
  const packetId = get(form, "packetId");
  try { await markStuckSupplierPacketUnknown(await headers(), { attemptId: get(form, "attemptId"), reason: get(form, "reason") }); }
  catch { redirect(`/staff/fulfillment/packets/${encodeURIComponent(packetId)}?error=reconcile`); }
  redirect(`/staff/fulfillment/packets/${encodeURIComponent(packetId)}?reconciled=unknown`);
}
