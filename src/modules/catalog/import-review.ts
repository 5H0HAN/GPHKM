export type ImportReviewItem = {
  field: string | null;
  label: string;
  message: string;
  section: "corrections" | "decisions";
};

const fieldLabels: Record<string, string> = {
  websiteUrl: "Website URL", title: "Title", description: "Description", countryCode: "Country code",
  primaryLanguage: "Language", categories: "GPHKM categories", linkType: "Link type", linkValidity: "Placement term",
  turnaroundDays: "Turnaround days", allowsSportsAndGaming: "Sports and gaming", allowsPharmacy: "Pharmacy",
  allowsCrypto: "Crypto", allowsForeignLanguage: "Foreign language", sponsoredContentMarking: "Sponsored marking",
  proposedRetailPriceUsd: "USD retail price", listing: "Listing details",
};

const missingMessages: Record<string, string> = {
  title: "Add a listing title.",
  description: "Add a listing description.",
  countryCode: "Enter the two-letter country code.",
  primaryLanguage: "Choose the listing language.",
  categories: "Choose one to seven GPHKM categories for this row.",
  linkType: "Choose the link type.",
  linkValidity: "Choose the placement term.",
  turnaroundDays: "Enter the confirmed number of turnaround days.",
  sponsoredContentMarking: "Confirm whether the post is marked as sponsored.",
};

const requiredFields = ["title", "description", "countryCode", "primaryLanguage", "linkType", "linkValidity", "turnaroundDays", "sponsoredContentMarking"];

function fieldMessage(field: string) {
  if (field === "categories") return "Choose one to seven GPHKM categories for this row.";
  if (field === "countryCode") return "Enter a two-letter country code, such as US.";
  if (field === "websiteUrl") return "Enter a valid HTTPS website URL or a bare domain.";
  if (["allowsSportsAndGaming", "allowsPharmacy", "allowsCrypto", "allowsForeignLanguage", "sponsoredContentMarking"].includes(field)) {
    return "Choose Yes or No.";
  }
  return missingMessages[field] ?? `Enter a valid ${fieldLabels[field] ?? "value"}.`;
}

function errorMessage(field: string, code: string) {
  if (code === "INVALID_HTTPS_ORIGIN") return "Enter a valid HTTPS website URL or a bare domain.";
  if (code === "INVALID_TEXT") return field === "title" ? "Enter a title up to 120 characters." : "Enter a description up to 4,000 characters.";
  if (code === "INVALID_COUNTRY_CODE") return "Enter a two-letter country code, such as US.";
  if (code === "INVALID_LANGUAGE") return "Choose a supported language.";
  if (code === "INVALID_CATEGORIES") return "Choose one to seven GPHKM categories for this row.";
  if (code === "INVALID_LINK_TYPE") return "Choose a supported link type.";
  if (code === "INVALID_VALIDITY") return "Choose a supported placement term.";
  if (code === "INVALID_TURNAROUND") return "Enter a whole number of days from 1 to 365.";
  if (code === "INVALID_BOOLEAN") return "Choose Yes or No.";
  if (code === "IMPORT_FORMULA_REJECTED") return "The source contains a spreadsheet formula. Enter a plain value in the correction form.";
  if (code.includes("CELL")) return "This source value could not be read. Enter a plain text or numeric value.";
  if (code === "DRAFT_VALIDATION_FAILED") return "Some listing details do not meet the inventory requirements. Review the fields below.";
  return fieldMessage(field);
}

export function buildImportReviewItems(input: {
  status: string;
  values: Record<string, unknown>;
  errors: Array<{ field: string; code: string }>;
  warnings: string[];
  platformCategories: string[];
  retailPriceSaved: boolean;
  duplicateOfRow: number | null;
}): ImportReviewItem[] {
  if (input.status === "APPLIED" || input.status === "REJECTED") return [];
  const items: ImportReviewItem[] = [];
  const fieldsAdded = new Set<string>();
  const addField = (field: string, message: string) => {
    if (fieldsAdded.has(field)) return;
    fieldsAdded.add(field);
    items.push({ field: field === "listing" ? null : field, label: fieldLabels[field] ?? "Listing details", message, section: "corrections" });
  };

  for (const error of input.errors) {
    if (error.field === "categories" && input.platformCategories.length > 0) continue;
    addField(error.field, errorMessage(error.field, error.code));
  }

  let needsGenericReview = false;
  for (const warning of input.warnings) {
    if (warning.startsWith("FIELD_VALUE_NEEDS_REVIEW:")) {
      const field = warning.slice("FIELD_VALUE_NEEDS_REVIEW:".length);
      if (field !== "categories" || input.platformCategories.length === 0) addField(field, fieldMessage(field));
    } else if (warning === "CATEGORY_ROW_MAPPING_REQUIRED" || warning === "CATEGORY_MAPPING_CONFIRMATION_REQUIRED" || warning === "CATEGORY_ALIAS_REVIEW_REQUIRED") {
      if (input.platformCategories.length === 0) addField("categories", missingMessages.categories);
    } else if (warning === "WEBSITE_NEW_MARKER_CONFIRMATION_REQUIRED") {
      addField("websiteUrl", "The supplier marked this site as new. Confirm the URL and remove the ‘New’ marker from the Website URL field.");
    } else if (warning === "TURNAROUND_INSTANT_REVIEW_REQUIRED") {
      addField("turnaroundDays", "The supplier says ‘Instant’. Confirm the actual number of days in the Turnaround days field.");
    } else if (warning !== "LISTING_DETAILS_NEED_REVIEW" && warning !== "POSSIBLE_DUPLICATE_DOMAIN" && warning.endsWith("_REVIEW_REQUIRED")) {
      needsGenericReview = true;
    }
  }

  if (input.platformCategories.length === 0) addField("categories", missingMessages.categories);
  for (const field of requiredFields) {
    const value = input.values[field];
    if ((value === undefined || value === null || value === "") && !fieldsAdded.has(field)) addField(field, missingMessages[field]);
  }
  if (!input.retailPriceSaved) addField("proposedRetailPriceUsd", "Enter a USD retail price before importing this row.");
  if (needsGenericReview) addField("listing", "Review the listing details and save the corrections before importing.");
  if (input.status === "DUPLICATE_REVIEW") {
    items.push({
      field: null,
      label: "Possible website match",
      message: input.duplicateOfRow
        ? `This website also appears in row ${input.duplicateOfRow}. Compare the rows, then keep this offer separately or reject it with a reason.`
        : "Compare the matched listing, then keep this offer separately or reject it with a reason.",
      section: "decisions",
    });
  }
  if (!items.length && input.status !== "READY" && input.status !== "APPLIED" && input.status !== "REJECTED") {
    items.push({ field: null, label: "Row status", message: "Review this row and save its corrections before importing.", section: "corrections" });
  }
  return items;
}
