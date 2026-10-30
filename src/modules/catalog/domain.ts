import {
  isValidListingCategorySelection,
  LISTING_LANGUAGES,
  LISTING_LINK_TYPES,
  LISTING_LINK_VALIDITIES,
  type ListingCategoryName,
  type ListingLanguage,
  type ListingLinkType,
  type ListingLinkValidity,
} from "./taxonomy.ts";

export type StaffRole = "ADMIN" | "FINANCE" | "SUPER_ADMIN";
export type CommercialSource = "PLATFORM_OWNED" | "SUPPLIER_SOURCED";
export type ListingStatus = "DRAFT" | "REVIEW" | "LIVE" | "PAUSED" | "ARCHIVED";

export type ListingTerms = {
  title: string;
  description: string;
  websiteUrl: string;
  countryCode: string;
  primaryLanguage: ListingLanguage;
  categories: ListingCategoryName[];
  retailPriceCents: number;
  linkType: ListingLinkType;
  linkValidity: ListingLinkValidity;
  turnaroundDays: number;
  allowsSportsAndGaming: boolean | null;
  allowsPharmacy: boolean | null;
  allowsCrypto: boolean | null;
  allowsForeignLanguage: boolean | null;
  sponsoredContentMarking: boolean;
  writingEnabled: boolean;
  writingPriceCents: number | null;
  writingTurnaroundDays: number | null;
  writingFirstDraftCents: number | null;
  writingFinalDraftCents: number | null;
  buyerRequirements: string | null;
};

export type ListingMetric = {
  provider: "OPEN_PAGE_RANK" | "AHREFS_DR" | "MOZ_DA";
  metricScope: "REGISTERED_DOMAIN" | "DOMAIN" | "HOST";
  value: number | null;
  status: "AVAILABLE" | "MISSING" | "STALE" | "FAILED";
  observedOn: string | null;
  source: string;
  redistributionApproved: boolean;
  attributionText: string | null;
};

export type ListingRecord = ListingTerms & {
  id: string;
  revision: number;
  status: ListingStatus;
  commercialSource: CommercialSource;
  supplierId: string | null;
  fulfillmentSupplierId: string | null;
  sourceCostCents: number | null;
  urlVisibleWithoutRecharge: boolean;
  metrics: ListingMetric[];
  createdAt: string;
  updatedAt: string;
};

export type ListingValidationError = { field: string; code: string };

const stringLimits: Record<string, number> = {
  title: 120,
  description: 4_000,
  websiteUrl: 2_048,
  buyerRequirements: 4_000,
};
const languages = new Set<string>(LISTING_LANGUAGES);
const linkTypes = new Set<string>(LISTING_LINK_TYPES);
const validities = new Set<string>(LISTING_LINK_VALIDITIES);

export function normalizeWebsiteUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash || url.hostname.length > 253 ||
      url.hostname === "localhost" || !url.hostname.includes(".") ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/i.test(url.hostname) ||
      !/[a-z]/i.test(url.hostname.split(".").at(-1) ?? "")
    ) return null;
    return `https://${url.hostname.toLowerCase()}/`;
  } catch {
    return null;
  }
}

export function validateListingTerms(input: unknown): ListingValidationError[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [{ field: "", code: "OBJECT_REQUIRED" }];
  const terms = input as Record<string, unknown>;
  const errors: ListingValidationError[] = [];
  for (const [field, max] of Object.entries(stringLimits)) {
    const value = terms[field];
    if (field === "buyerRequirements" && value === null) continue;
    if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
      errors.push({ field, code: "INVALID_TEXT" });
    }
  }
  if (!normalizeWebsiteUrl(terms.websiteUrl)) errors.push({ field: "websiteUrl", code: "INVALID_HTTPS_ORIGIN" });
  if (typeof terms.countryCode !== "string" || !/^[A-Z]{2}$/.test(terms.countryCode)) {
    errors.push({ field: "countryCode", code: "INVALID_COUNTRY_CODE" });
  }
  if (typeof terms.primaryLanguage !== "string" || !languages.has(terms.primaryLanguage)) {
    errors.push({ field: "primaryLanguage", code: "INVALID_LANGUAGE" });
  }
  if (!isValidListingCategorySelection(terms.categories)) errors.push({ field: "categories", code: "INVALID_CATEGORIES" });
  if (typeof terms.retailPriceCents !== "number" || !Number.isSafeInteger(terms.retailPriceCents) || terms.retailPriceCents < 1) {
    errors.push({ field: "retailPriceCents", code: "INVALID_MONEY" });
  }
  if (typeof terms.linkType !== "string" || !linkTypes.has(terms.linkType)) errors.push({ field: "linkType", code: "INVALID_LINK_TYPE" });
  if (typeof terms.linkValidity !== "string" || !validities.has(terms.linkValidity)) errors.push({ field: "linkValidity", code: "INVALID_VALIDITY" });
  if (typeof terms.turnaroundDays !== "number" || !Number.isInteger(terms.turnaroundDays) || terms.turnaroundDays < 1 || terms.turnaroundDays > 365) {
    errors.push({ field: "turnaroundDays", code: "INVALID_TURNAROUND" });
  }
  for (const field of ["allowsSportsAndGaming", "allowsPharmacy", "allowsCrypto", "allowsForeignLanguage"]) {
    if (typeof terms[field] !== "boolean" && terms[field] !== null) errors.push({ field, code: "POLICY_FLAG_REQUIRED" });
  }
  if (typeof terms.sponsoredContentMarking !== "boolean") errors.push({ field: "sponsoredContentMarking", code: "BOOLEAN_REQUIRED" });
  if (typeof terms.writingEnabled !== "boolean") errors.push({ field: "writingEnabled", code: "BOOLEAN_REQUIRED" });
  if (terms.writingEnabled === true) {
    const amounts = [terms.writingPriceCents, terms.writingFirstDraftCents, terms.writingFinalDraftCents];
    if (amounts.some((value) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
      errors.push({ field: "writingPriceCents", code: "INVALID_WRITING_PRICE" });
    } else if ((amounts[1] as number) + (amounts[2] as number) !== amounts[0]) {
      errors.push({ field: "writingPriceCents", code: "WRITING_STAGES_MUST_EQUAL_PRICE" });
    }
    if (typeof terms.writingTurnaroundDays !== "number" || !Number.isInteger(terms.writingTurnaroundDays) || terms.writingTurnaroundDays < 1 || terms.writingTurnaroundDays > 365) {
      errors.push({ field: "writingTurnaroundDays", code: "INVALID_TURNAROUND" });
    }
  } else if ([terms.writingPriceCents, terms.writingTurnaroundDays, terms.writingFirstDraftCents, terms.writingFinalDraftCents].some((value) => value !== null)) {
    errors.push({ field: "writingEnabled", code: "WRITING_FIELDS_REQUIRE_ADDON" });
  }
  return errors;
}

export function validatePublishableListing(listing: ListingRecord): ListingValidationError[] {
  const errors = validateListingTerms(listing);
  if ([listing.allowsSportsAndGaming, listing.allowsPharmacy, listing.allowsCrypto, listing.allowsForeignLanguage].some((value) => value === null)) {
    errors.push({ field: "topicPermissions", code: "TOPIC_FLAGS_MUST_BE_REVIEWED" });
  }
  errors.push(...validateListingRelationships(listing.commercialSource, listing.supplierId, listing.fulfillmentSupplierId));
  if (!listing.urlVisibleWithoutRecharge) {
    const buyerCopy = [listing.title, listing.description, listing.buyerRequirements ?? ""];
    const hostname = normalizeWebsiteUrl(listing.websiteUrl)?.replace(/^https:\/\//, "").replace(/\/$/, "");
    if (buyerCopy.some((text) => containsWebsiteAddress(text, hostname))) {
      errors.push({ field: "buyerCopy", code: "HIDDEN_WEBSITE_ADDRESS_IN_BUYER_COPY" });
    }
  }
  return errors;
}

export function containsWebsiteAddress(text: string, hostname?: string): boolean {
  return /https?:\/\/|\bwww\./i.test(text)
    || Boolean(hostname && text.toLowerCase().includes(hostname))
    || /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/i.test(text);
}

export function validateListingRelationships(source: CommercialSource, supplierId: unknown, fulfillmentSupplierId: unknown): ListingValidationError[] {
  const errors: ListingValidationError[] = [];
  if (source !== "PLATFORM_OWNED" && source !== "SUPPLIER_SOURCED") errors.push({ field: "commercialSource", code: "INVALID_SOURCE" });
  if (source === "SUPPLIER_SOURCED" && (typeof supplierId !== "string" || !supplierId)) {
    errors.push({ field: "supplierId", code: "SUPPLIER_REQUIRED" });
  }
  if (source === "SUPPLIER_SOURCED" && typeof supplierId === "string" && supplierId) {
    if (typeof fulfillmentSupplierId !== "string" || !fulfillmentSupplierId) {
      errors.push({ field: "fulfillmentSupplierId", code: "FULFILLMENT_SUPPLIER_REQUIRED" });
    } else if (supplierId !== fulfillmentSupplierId) {
      errors.push({ field: "fulfillmentSupplierId", code: "SUPPLIER_MISMATCH" });
    }
  }
  if (source === "PLATFORM_OWNED" && supplierId !== null) errors.push({ field: "supplierId", code: "PLATFORM_SOURCE_MUST_NOT_HAVE_SOURCE_SUPPLIER" });
  if (fulfillmentSupplierId !== null && typeof fulfillmentSupplierId !== "string") {
    errors.push({ field: "fulfillmentSupplierId", code: "INVALID_FULFILLMENT_CONTACT" });
  }
  return errors;
}

export function canManageCatalog(role: StaffRole): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

export function canViewSourceCosts(role: StaffRole): boolean {
  return role === "FINANCE" || role === "SUPER_ADMIN";
}

export function canTransitionListing(from: ListingStatus, to: ListingStatus, role: StaffRole): boolean {
  if (!canManageCatalog(role)) return false;
  const allowed: Record<ListingStatus, ListingStatus[]> = {
    DRAFT: ["REVIEW", "ARCHIVED"],
    REVIEW: ["DRAFT", "LIVE", "ARCHIVED"],
    LIVE: ["PAUSED", "ARCHIVED"],
    PAUSED: ["LIVE", "ARCHIVED"],
    ARCHIVED: [],
  };
  return allowed[from].includes(to);
}

export function makeListingSnapshot(listing: ListingRecord): Readonly<ListingTerms & { listingId: string; revision: number }> {
  return Object.freeze({
    listingId: listing.id,
    revision: listing.revision,
    title: listing.title,
    description: listing.description,
    websiteUrl: listing.websiteUrl,
    countryCode: listing.countryCode,
    primaryLanguage: listing.primaryLanguage,
    categories: Object.freeze([...listing.categories]) as unknown as ListingCategoryName[],
    retailPriceCents: listing.retailPriceCents,
    linkType: listing.linkType,
    linkValidity: listing.linkValidity,
    turnaroundDays: listing.turnaroundDays,
    allowsSportsAndGaming: listing.allowsSportsAndGaming,
    allowsPharmacy: listing.allowsPharmacy,
    allowsCrypto: listing.allowsCrypto,
    allowsForeignLanguage: listing.allowsForeignLanguage,
    sponsoredContentMarking: listing.sponsoredContentMarking,
    writingEnabled: listing.writingEnabled,
    writingPriceCents: listing.writingPriceCents,
    writingTurnaroundDays: listing.writingTurnaroundDays,
    writingFirstDraftCents: listing.writingFirstDraftCents,
    writingFinalDraftCents: listing.writingFinalDraftCents,
    buyerRequirements: listing.buyerRequirements,
  });
}

export type CustomerListing = {
  id: string;
  revision: number;
  title: string;
  description: string;
  countryCode: string;
  primaryLanguage: ListingLanguage;
  categories: ListingCategoryName[];
  retailPriceCents: number;
  linkType: ListingLinkType;
  linkValidity: ListingLinkValidity;
  turnaroundDays: number;
  allowsSportsAndGaming: boolean;
  allowsPharmacy: boolean;
  allowsCrypto: boolean;
  allowsForeignLanguage: boolean;
  sponsoredContentMarking: boolean;
  writingEnabled: boolean;
  writingPriceCents: number | null;
  writingTurnaroundDays: number | null;
  writingFirstDraftCents: number | null;
  writingFinalDraftCents: number | null;
  buyerRequirements: string | null;
  websiteUrl?: string;
  metrics: Array<Pick<ListingMetric, "provider" | "metricScope" | "value" | "status" | "observedOn" | "source" | "attributionText">>;
};

// Entitlements must be resolved server-side; never pass values copied from request data.
export function toCustomerListing(listing: ListingRecord, access: { canBrowse: boolean; hasHiddenUrlAccess: boolean }): CustomerListing | null {
  if (listing.status !== "LIVE" || !access.canBrowse || validatePublishableListing(listing).length > 0) return null;
  const result: CustomerListing = {
    id: listing.id,
    revision: listing.revision,
    title: listing.title,
    description: listing.description,
    countryCode: listing.countryCode,
    primaryLanguage: listing.primaryLanguage,
    categories: [...listing.categories],
    retailPriceCents: listing.retailPriceCents,
    linkType: listing.linkType,
    linkValidity: listing.linkValidity,
    turnaroundDays: listing.turnaroundDays,
    allowsSportsAndGaming: listing.allowsSportsAndGaming === true,
    allowsPharmacy: listing.allowsPharmacy === true,
    allowsCrypto: listing.allowsCrypto === true,
    allowsForeignLanguage: listing.allowsForeignLanguage === true,
    sponsoredContentMarking: listing.sponsoredContentMarking,
    writingEnabled: listing.writingEnabled,
    writingPriceCents: listing.writingEnabled ? listing.writingPriceCents : null,
    writingTurnaroundDays: listing.writingEnabled ? listing.writingTurnaroundDays : null,
    writingFirstDraftCents: listing.writingEnabled ? listing.writingFirstDraftCents : null,
    writingFinalDraftCents: listing.writingEnabled ? listing.writingFinalDraftCents : null,
    buyerRequirements: listing.buyerRequirements,
    metrics: listing.metrics.filter((metric) =>
      metric.status === "AVAILABLE" && metric.redistributionApproved && metric.attributionText,
    ).map((metric) => ({
      provider: metric.provider,
      metricScope: metric.metricScope,
      value: metric.value,
      status: metric.status,
      observedOn: metric.observedOn,
      source: metric.source,
      attributionText: metric.attributionText,
    })),
  };
  if (listing.urlVisibleWithoutRecharge || access.hasHiddenUrlAccess) {
    result.websiteUrl = listing.websiteUrl;
  }
  return result;
}

export type SupplierRecord = {
  id: string;
  name: string;
  contactName: string | null;
  email: string;
  phone: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export function validateSupplierInput(input: unknown): ListingValidationError[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [{ field: "", code: "OBJECT_REQUIRED" }];
  const supplier = input as Record<string, unknown>;
  const errors: ListingValidationError[] = [];
  for (const [field, max, required] of [["name", 160, true], ["contactName", 160, false], ["email", 254, true], ["phone", 64, false], ["notes", 2_000, false]] as const) {
    const value = supplier[field];
    if ((value === null || value === undefined) && !required) continue;
    if (typeof value !== "string" || (required && !value.trim()) || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
      errors.push({ field, code: "INVALID_TEXT" });
    }
  }
  if (typeof supplier.email === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplier.email.trim())) {
    errors.push({ field: "email", code: "INVALID_EMAIL" });
  }
  return errors;
}

export function toSupplierProjection(supplier: SupplierRecord, role: StaffRole) {
  if (role === "FINANCE") return null;
  return {
    id: supplier.id,
    name: supplier.name,
    contactName: supplier.contactName,
    email: supplier.email,
    phone: supplier.phone,
    notes: supplier.notes,
    active: supplier.active,
    createdAt: supplier.createdAt,
    updatedAt: supplier.updatedAt,
  };
}

export function toInternalListingProjection(listing: ListingRecord, role: StaffRole) {
  if (role === "FINANCE") return null;
  const common = {
    id: listing.id,
    revision: listing.revision,
    status: listing.status,
    terms: makeListingSnapshot(listing),
    commercialSource: listing.commercialSource,
    supplierId: listing.supplierId,
    fulfillmentSupplierId: listing.fulfillmentSupplierId,
    urlVisibleWithoutRecharge: listing.urlVisibleWithoutRecharge,
    metrics: listing.metrics,
  };
  return canViewSourceCosts(role) ? { ...common, sourceCostCents: listing.sourceCostCents } : common;
}

export function toFinanceCostProjection(listing: ListingRecord, role: StaffRole) {
  if (!canViewSourceCosts(role)) return null;
  return {
    listingId: listing.id,
    revision: listing.revision,
    retailPriceCents: listing.retailPriceCents,
    sourceCostCents: listing.sourceCostCents,
  };
}
