"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { activateStaff, changeStaffRole, deactivateStaff, inviteStaff, revokeStaffInvitation } from "@/server/identity/staff-lifecycle";

function field(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function confirm(form: FormData) {
  if (form.get("confirmed") !== "on") throw new Error("Confirmation required");
}

export async function activateStaffAction(form: FormData) {
  const userId = field(form, "userId");
  try { confirm(form); await activateStaff(await headers(), userId); }
  catch { redirect("/staff/team?error=action-failed"); }
  revalidatePath("/staff/team");
  redirect("/staff/team?updated=activated");
}

export async function changeStaffRoleAction(form: FormData) {
  const userId = field(form, "userId");
  const role = field(form, "role");
  let changed: boolean;
  try {
    confirm(form);
    if (role !== "ADMIN" && role !== "FINANCE") throw new Error("Invalid role");
    changed = await changeStaffRole(await headers(), userId, role);
  } catch { redirect("/staff/team?error=action-failed"); }
  revalidatePath("/staff/team");
  redirect(changed ? "/staff/team?updated=role" : "/staff/team?updated=unchanged");
}

export async function deactivateStaffAction(form: FormData) {
  const userId = field(form, "userId");
  const reasonCode = field(form, "reasonCode");
  try { confirm(form); await deactivateStaff(await headers(), userId, reasonCode); }
  catch { redirect("/staff/team?error=action-failed"); }
  revalidatePath("/staff/team");
  redirect("/staff/team?updated=deactivated");
}

export async function inviteStaffAction(form: FormData) {
  const email = field(form, "email");
  const role = field(form, "role");
  try {
    confirm(form);
    if (role !== "ADMIN" && role !== "FINANCE") throw new Error("Invalid role");
    await inviteStaff(await headers(), email, role);
  } catch { redirect("/staff/team?error=invite"); }
  revalidatePath("/staff/team");
  redirect("/staff/team?updated=invitation");
}

export async function revokeStaffInvitationAction(form: FormData) {
  const invitationId = field(form, "invitationId");
  try { confirm(form); await revokeStaffInvitation(await headers(), invitationId); }
  catch { redirect("/staff/team?error=invitation"); }
  revalidatePath("/staff/team");
  redirect("/staff/team?updated=invitation");
}
