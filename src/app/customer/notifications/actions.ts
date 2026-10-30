"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { markCustomerNotificationRead } from "@/server/notifications/customer";

function field(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

export async function markNotificationReadAction(form: FormData) {
  const organizationId = field(form, "organizationId");
  const notificationId = field(form, "notificationId");
  const page = field(form, "page");
  const target = `/customer/notifications?organizationId=${encodeURIComponent(organizationId)}${/^[1-9]\d{0,5}$/.test(page) ? `&page=${page}` : ""}`;
  try { await markCustomerNotificationRead(await headers(), organizationId, notificationId); }
  catch { redirect(`${target}&error=1`); }
  redirect(target);
}
