"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireStaffAccess } from "@/server/auth/staff";
import { LISTING_CATEGORY_NAMES, LISTING_LANGUAGES, LISTING_LINK_TYPES, LISTING_LINK_VALIDITIES } from "@/modules/catalog/taxonomy";
import type { ListingTerms } from "@/modules/catalog/domain";
import { createDraftListing, transitionListing, updateListing } from "@/server/catalog/admin";
import type { ListingStatus } from "@/modules/catalog/domain";

function value(form: FormData, key: string): string {
  const entry = form.get(key);
  return typeof entry === "string" ? entry.trim() : "";
}

function dollars(value: string): number | null {
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) return null;
  const amount = Math.round(Number(value) * 100);
  return Number.isSafeInteger(amount) ? amount : null;
}

function flag(form: FormData, key: string): boolean | null {
  const raw = value(form, key);
  return raw === "yes" ? true : raw === "no" ? false : null;
}

function listingTerms(form: FormData): ListingTerms | null {
  const price = dollars(value(form, "retailPrice"));
  const writingEnabled = value(form, "writingEnabled") === "yes";
  const writingPrice = writingEnabled ? dollars(value(form, "writingPrice")) : null;
  const firstDraft = writingEnabled ? dollars(value(form, "writingFirstDraft")) : null;
  const finalDraft = writingEnabled ? dollars(value(form, "writingFinalDraft")) : null;
  const categories = form.getAll("categories").filter((part): part is string => typeof part === "string").map((part) => part.trim()).filter(Boolean);
  const language = value(form, "primaryLanguage");
  const linkType = value(form, "linkType");
  const linkValidity = value(form, "linkValidity");
  if (!LISTING_LANGUAGES.includes(language as never) || !LISTING_LINK_TYPES.includes(linkType as never)
    || !LISTING_LINK_VALIDITIES.includes(linkValidity as never)
    || categories.length < 1 || categories.length > 7 || !categories.every((category) => LISTING_CATEGORY_NAMES.includes(category as never))) return null;
  return {
    title: value(form, "title"), description: value(form, "description"), websiteUrl: value(form, "websiteUrl"),
    countryCode: value(form, "countryCode").toUpperCase(), primaryLanguage: language as ListingTerms["primaryLanguage"],
    categories: categories as ListingTerms["categories"], retailPriceCents: price ?? -1,
    linkType: linkType as ListingTerms["linkType"], linkValidity: linkValidity as ListingTerms["linkValidity"],
    turnaroundDays: Number(value(form, "turnaroundDays")), allowsSportsAndGaming: flag(form, "allowsSportsAndGaming"),
    allowsPharmacy: flag(form, "allowsPharmacy"), allowsCrypto: flag(form, "allowsCrypto"),
    allowsForeignLanguage: flag(form, "allowsForeignLanguage"), sponsoredContentMarking: value(form, "sponsoredContentMarking") === "yes",
    writingEnabled, writingPriceCents: writingPrice,
    writingTurnaroundDays: writingEnabled ? Number(value(form, "writingTurnaroundDays")) : null,
    writingFirstDraftCents: firstDraft, writingFinalDraftCents: finalDraft,
    buyerRequirements: value(form, "buyerRequirements") || null,
  };
}

export async function createListingAction(form: FormData) {
  const requestHeaders = await headers();
  try {
    await requireStaffAccess(requestHeaders, "catalog.manage");
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") redirect("/staff/sign-in");
    if (error instanceof Error && error.message === "Forbidden") redirect("/staff");
    throw error;
  }

  const terms = listingTerms(form);
  if (!terms) redirect("/staff/catalog/new?error=invalid-options");
  const source = value(form, "commercialSource");
  const supplierId = value(form, "supplierId") || null;
  let created: { id: string };
  try {
    created = await createDraftListing(requestHeaders, { terms, commercialSource: source as "PLATFORM_OWNED" | "SUPPLIER_SOURCED", supplierId: source === "SUPPLIER_SOURCED" ? supplierId : null, fulfillmentSupplierId: value(form, "fulfillmentSupplierId") || null, urlVisibleWithoutRecharge: value(form, "urlVisibleWithoutRecharge") === "yes" });
  } catch {
    redirect("/staff/catalog/new?error=invalid-or-not-authorized");
  }
  redirect(`/staff/catalog?created=${created.id}`);
}

export async function editListingAction(form: FormData) {
  const id = value(form, "id");
  const expectedRevision = Number(value(form, "expectedRevision"));
  const terms = listingTerms(form);
  const source = value(form, "commercialSource");
  if (!terms || (source !== "PLATFORM_OWNED" && source !== "SUPPLIER_SOURCED")) redirect(`/staff/catalog/${encodeURIComponent(id)}/edit?error=invalid`);
  try {
    await updateListing(await headers(), {
      id, expectedRevision, terms, commercialSource: source,
      supplierId: source === "SUPPLIER_SOURCED" ? value(form, "supplierId") || null : null,
      fulfillmentSupplierId: value(form, "fulfillmentSupplierId") || null,
      urlVisibleWithoutRecharge: value(form, "urlVisibleWithoutRecharge") === "yes",
      reason: value(form, "reason"),
    });
  } catch {
    redirect(`/staff/catalog/${encodeURIComponent(id)}/edit?error=save-failed`);
  }
  redirect(`/staff/catalog?updated=1`);
}

export async function transitionListingAction(form: FormData) {
  const id = form.get("id");
  const status = form.get("status");
  if (typeof id !== "string" || typeof status !== "string") redirect("/staff/catalog?error=invalid");
  try {
    await transitionListing(await headers(), id, status as ListingStatus);
  } catch {
    redirect("/staff/catalog?error=transition-failed");
  }
  redirect("/staff/catalog?updated=1");
}
