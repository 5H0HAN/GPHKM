"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { changeListingSourceCost, recordActualOrderCost, searchSupplierTransferItems } from "@/server/catalog/supplier-finance";

function value(form: FormData, key: string) {
  const result = form.get(key);
  return typeof result === "string" ? result : "";
}

function pageValue(form: FormData, key: string) {
  const page = value(form, key);
  return /^[1-9]\d{0,5}$/.test(page) ? page : "1";
}

function financeQuery(form: FormData) {
  return `listingsPage=${pageValue(form, "listingsPage")}&orderItemsPage=${pageValue(form, "orderItemsPage")}&transfersPage=${pageValue(form, "transfersPage")}`;
}

export async function searchSupplierTransferItemsAction(supplierId: string, query: string) {
  return searchSupplierTransferItems(await headers(), supplierId, query);
}

export async function changeListingCostAction(form: FormData) {
  try {
    await changeListingSourceCost(await headers(), { listingId: value(form, "listingId"), amount: value(form, "amount"), reason: value(form, "reason") });
  } catch { redirect(`/staff/suppliers/finance?error=cost&${financeQuery(form)}`); }
  redirect(`/staff/suppliers/finance?saved=listing-cost&${financeQuery(form)}`);
}

export async function recordActualCostAction(form: FormData) {
  try {
    const component = value(form, "component");
    if (component !== "PLACEMENT" && component !== "WRITING") throw new Error("Invalid component");
    const rawSupplierId = value(form, "supplierId");
    await recordActualOrderCost(await headers(), { orderItemId: value(form, "orderItemId"), component, supplierId: rawSupplierId || null, amount: value(form, "amount"), reason: value(form, "reason") });
  } catch { redirect(`/staff/suppliers/finance?error=actual-cost&${financeQuery(form)}`); }
  redirect(`/staff/suppliers/finance?saved=actual-cost&${financeQuery(form)}`);
}
