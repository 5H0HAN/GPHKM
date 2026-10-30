"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSupplier, saveSupplierContact, updateSupplierProfile } from "@/server/catalog/admin";

export async function createSupplierAction(form: FormData) {
  const name = form.get("name");
  const contactName = form.get("contactName");
  const email = form.get("email");
  if (typeof name !== "string" || typeof contactName !== "string" || typeof email !== "string") redirect("/staff/suppliers?error=invalid");
  try {
    await createSupplier(await headers(), { name, contactName, email });
  } catch {
    redirect("/staff/suppliers?error=invalid-or-not-authorized");
  }
  redirect("/staff/suppliers?created=1");
}

export async function updateSupplierProfileAction(form: FormData) {
  const id = form.get("supplierId"), name = form.get("name"), notes = form.get("notes"), status = form.get("status");
  if ([id, name, notes, status].some((value) => typeof value !== "string")) redirect("/staff/suppliers?error=invalid");
  try {
    await updateSupplierProfile(await headers(), { id: id as string, name: name as string, notes: notes as string,
      status: status as "ACTIVE" | "INACTIVE" });
  } catch { redirect(`/staff/suppliers/${encodeURIComponent(id as string)}?error=profile`); }
  redirect(`/staff/suppliers/${encodeURIComponent(id as string)}?saved=profile`);
}

export async function saveSupplierContactAction(form: FormData) {
  const supplierId = form.get("supplierId"), contactId = form.get("contactId"), name = form.get("name"), email = form.get("email"), roleLabel = form.get("roleLabel");
  if ([supplierId, name, email].some((value) => typeof value !== "string") || (contactId !== null && typeof contactId !== "string") || (roleLabel !== null && typeof roleLabel !== "string")) {
    redirect("/staff/suppliers?error=invalid");
  }
  try {
    await saveSupplierContact(await headers(), { supplierId: supplierId as string,
      ...(contactId ? { contactId: contactId as string } : {}), name: name as string, email: email as string,
      roleLabel: (roleLabel as string | null) ?? "", isPrimary: form.get("isPrimary") === "on" });
  } catch { redirect(`/staff/suppliers/${encodeURIComponent(supplierId as string)}?error=contact`); }
  redirect(`/staff/suppliers/${encodeURIComponent(supplierId as string)}?saved=contact`);
}
