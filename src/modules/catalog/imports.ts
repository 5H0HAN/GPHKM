import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { Worker } from "node:worker_threads";
import {
  LISTING_CATEGORY_NAMES,
  LISTING_LANGUAGES,
  LISTING_LINK_TYPES,
  LISTING_LINK_VALIDITIES,
  type ListingCategoryName,
  type ListingLanguage,
  type ListingLinkType,
  type ListingLinkValidity,
} from "./taxonomy.ts";
import { normalizeWebsiteUrl, type ListingTerms, type StaffRole } from "./domain.ts";

export const IMPORT_LIMITS = Object.freeze({
  fileBytes: 10 * 1024 * 1024,
  decompressedBytes: 32 * 1024 * 1024,
  entryBytes: 8 * 1024 * 1024,
  entries: 200,
  sheets: 10,
  rowsPerSheet: 5_000,
  columns: 32,
  cellChars: 8_000,
  xlsxParseMilliseconds: 10_000,
  xlsxParserMemoryMb: 128,
});

export type ImportField =
  | "websiteUrl" | "title" | "description" | "countryCode" | "primaryLanguage" | "categories"
  | "linkType" | "linkValidity" | "turnaroundDays"
  | "allowsSportsAndGaming" | "allowsPharmacy" | "allowsCrypto" | "allowsForeignLanguage" | "sponsoredContentMarking";

export type ImportMapping = Partial<Record<ImportField, number>>;
export type ImportError = { field: string; code: string };

export type ParsedSheet = { name: string; rows: unknown[][] };

export type ImportCandidate = {
  rowNumber: number;
  sourceDomain: string | null;
  values: Partial<Record<ImportField, string | number | boolean>>;
  errors: ImportError[];
  warnings: string[];
  duplicateOfRow: number | null;
  duplicateOfListingIds: string[];
  status: "NEEDS_REVIEW" | "INVALID" | "DUPLICATE_REVIEW" | "READY" | "APPLIED" | "REJECTED";
  duplicateResolution: { decision: "KEEP_SEPARATE" | "REJECT"; staffUserId: string; reason: string; decidedAt: string } | null;
};

export function getPersistableImportValues(candidate: ImportCandidate, row: unknown[], mapping: ImportMapping) {
  const originalValues: Record<string, string | number | boolean | null> = {};
  for (const [field, column] of Object.entries(mapping) as Array<[ImportField, number]>) {
    const value = row[column];
    if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      originalValues[field] = value ?? null;
    }
  }
  return { originalValues, stagedValues: candidate.values };
}

const fieldNames = new Set<ImportField>([
  "websiteUrl", "title", "description", "countryCode", "primaryLanguage", "categories",
  "linkType", "linkValidity", "turnaroundDays", "allowsSportsAndGaming", "allowsPharmacy", "allowsCrypto", "allowsForeignLanguage", "sponsoredContentMarking",
]);
const allowedCategories = new Set<string>(LISTING_CATEGORY_NAMES);
const allowedLanguages = new Set<string>(LISTING_LANGUAGES);
const allowedLinkTypes = new Set<string>(LISTING_LINK_TYPES);
const allowedLinkValidities = new Set<string>(LISTING_LINK_VALIDITIES);
const formulas = /^[\s\u0000-\u0020]*[=+\-@]/;
const blockedSpreadsheetExtensions = /\.(?:xlsm|xltm|xlsb|xls|xlam|xla)$/i;
const XLSX_PARSER_WORKER = `
  const { parentPort, workerData } = require("node:worker_threads");
  const { createRequire } = require("node:module");
  const { resolve } = require("node:path");
  const requireFromProject = createRequire(resolve(process.cwd(), "package.json"));
  const { Unzip, UnzipInflate, UnzipPassThrough } = requireFromProject("fflate");
  const readXlsxFile = requireFromProject("read-excel-file/node");
  const IMPORT_LIMITS = ${JSON.stringify(IMPORT_LIMITS)};
  const formulas = /^[\s\u0000-\u0020]*[=+\-@]/;
  const assertSafeArchivePath = (${assertSafeArchivePath.toString()});
  const isRelevantXml = (${isRelevantXml.toString()});
  const inspectXlsxArchive = (${inspectXlsxArchive.toString()});
  const safeCell = (${safeCell.toString()});
  const checkGrid = (${checkGrid.toString()});
  const buffer = Buffer.from(workerData);
  try {
    inspectXlsxArchive(buffer);
    readXlsxFile(buffer, { trim: false })
      .then((sheets) => {
        const parsed = sheets.map((sheet) => ({ name: sheet.sheet, rows: sheet.data }));
        for (const sheet of parsed) checkGrid(sheet.rows);
        parentPort.postMessage({ sheets: parsed });
      })
      .catch((error) => {
        const message = error instanceof Error && error.message.startsWith("IMPORT_") ? error.message : "IMPORT_XLSX_INVALID";
        parentPort.postMessage({ error: message });
      });
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("IMPORT_") ? error.message : "IMPORT_XLSX_INVALID";
    parentPort.postMessage({ error: message });
  }
`;

let activeXlsxParser = false;

function parseXlsxInBoundedWorker(buffer: Buffer): Promise<Array<{ name: string; rows: unknown[][] }>> {
  if (activeXlsxParser) return Promise.reject(new Error("IMPORT_XLSX_PARSER_BUSY"));
  activeXlsxParser = true;
  let worker: Worker;
  try {
    const bytes = Uint8Array.from(buffer);
    worker = new Worker(XLSX_PARSER_WORKER, {
      eval: true,
      workerData: bytes,
      transferList: [bytes.buffer],
      resourceLimits: {
        maxOldGenerationSizeMb: IMPORT_LIMITS.xlsxParserMemoryMb,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    });
  } catch (error) {
    activeXlsxParser = false;
    throw error;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let parseError: Error | null = null;
    let parsedSheets: Array<{ name: string; rows: unknown[][] }> | null = null;
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      void worker.terminate();
    }, IMPORT_LIMITS.xlsxParseMilliseconds);
    const finish = (error: Error | null, sheets?: Array<{ name: string; rows: unknown[][] }>) => {
      if (settled) return;
      settled = true;
      activeXlsxParser = false;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(sheets ?? []);
    };
    worker.once("message", (message: { sheets?: Array<{ name: string; rows: unknown[][] }>; error?: string }) => {
      if (message.error) parseError = new Error(message.error);
      else if (Array.isArray(message.sheets)) parsedSheets = message.sheets;
      else parseError = new Error("IMPORT_XLSX_INVALID");
    });
    worker.once("error", () => {
      parseError = new Error("IMPORT_XLSX_INVALID");
      void worker.terminate();
    });
    worker.once("exit", (code) => {
      if (timedOut) return finish(new Error("IMPORT_XLSX_PARSE_TIMEOUT"));
      if (parseError) return finish(parseError);
      if (code !== 0 || !parsedSheets) return finish(new Error("IMPORT_XLSX_INVALID"));
      finish(null, parsedSheets);
    });
  });
}

function safeCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.length > IMPORT_LIMITS.cellChars || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
      throw new Error("IMPORT_CELL_INVALID");
    }
    if (formulas.test(value)) throw new Error("IMPORT_FORMULA_REJECTED");
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  throw new Error("IMPORT_CELL_TYPE_REJECTED");
}

function checkGrid(rows: unknown[][]): void {
  if (rows.length > IMPORT_LIMITS.rowsPerSheet + 1) throw new Error("IMPORT_ROW_LIMIT_EXCEEDED");
  if (rows.some((row) => !Array.isArray(row) || row.length > IMPORT_LIMITS.columns)) throw new Error("IMPORT_COLUMN_LIMIT_EXCEEDED");
  for (const row of rows) for (const value of row) safeCell(value);
}

export function parseCsv(text: string): ParsedSheet {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > IMPORT_LIMITS.fileBytes) throw new Error("IMPORT_FILE_TOO_LARGE");
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let afterQuote = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = false; afterQuote = true; }
      } else cell += char;
    } else if (char === '"') {
      if (cell !== "" || afterQuote) throw new Error("IMPORT_CSV_INVALID");
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell); cell = ""; afterQuote = false;
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(cell); cell = ""; afterQuote = false;
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length > IMPORT_LIMITS.rowsPerSheet + 1) throw new Error("IMPORT_ROW_LIMIT_EXCEEDED");
    } else {
      if (afterQuote && !/[\t ]/.test(char)) throw new Error("IMPORT_CSV_INVALID");
      if (!afterQuote) cell += char;
    }
    if (cell.length > IMPORT_LIMITS.cellChars) throw new Error("IMPORT_CELL_INVALID");
    if (row.length >= IMPORT_LIMITS.columns) throw new Error("IMPORT_COLUMN_LIMIT_EXCEEDED");
  }
  if (inQuotes) throw new Error("IMPORT_CSV_INVALID");
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  if (rows.length < 2) throw new Error("IMPORT_HEADER_AND_ROWS_REQUIRED");
  checkGrid(rows);
  return { name: "CSV", rows };
}

function assertSafeArchivePath(path: string): void {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  if (
    !normalized || normalized.length > 512 || normalized.startsWith("/") || path.includes("\\") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..") ||
    /^[a-zA-Z]:/.test(normalized)
  ) throw new Error("IMPORT_ARCHIVE_PATH_REJECTED");
  if (/^xl\/(?:externalLinks(?:\/|$)|vbaProject\.bin$)/i.test(normalized)) throw new Error("IMPORT_EXTERNAL_OR_MACRO_CONTENT_REJECTED");
}

function isRelevantXml(path: string): boolean {
  return path === "[Content_Types].xml" || path === "xl/workbook.xml" ||
    path.endsWith(".rels") || /^xl\/worksheets\/sheet\d+\.xml$/i.test(path);
}

function inspectXlsxArchive(buffer: Buffer): Map<string, Buffer> {
  if (buffer.byteLength < 22 || buffer.byteLength > IMPORT_LIMITS.fileBytes || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error("IMPORT_XLSX_INVALID");
  }
  const files = new Map<string, Buffer>();
  const allNames = new Set<string>();
  let totalOutput = 0;
  let entryCount = 0;
  let failure: Error | null = null;
  const unzip = new Unzip((file) => {
    try {
      entryCount++;
      if (entryCount > IMPORT_LIMITS.entries) throw new Error("IMPORT_ENTRY_LIMIT_EXCEEDED");
      const name = file.name;
      assertSafeArchivePath(name);
      if (allNames.has(name)) throw new Error("IMPORT_DUPLICATE_ARCHIVE_ENTRY");
      allNames.add(name);
      if (file.compression !== 0 && file.compression !== 8) throw new Error("IMPORT_COMPRESSION_REJECTED");
      if (file.originalSize !== undefined && file.originalSize > IMPORT_LIMITS.entryBytes) throw new Error("IMPORT_ENTRY_TOO_LARGE");
      if (file.size !== undefined && file.size > IMPORT_LIMITS.fileBytes) throw new Error("IMPORT_ENTRY_TOO_LARGE");
      const chunks: Uint8Array[] = [];
      let entryBytes = 0;
      file.ondata = (error, chunk, final) => {
        if (error) { failure = new Error("IMPORT_XLSX_INVALID"); return; }
        entryBytes += chunk.byteLength;
        totalOutput += chunk.byteLength;
        if (entryBytes > IMPORT_LIMITS.entryBytes || totalOutput > IMPORT_LIMITS.decompressedBytes) {
          failure = new Error("IMPORT_DECOMPRESSED_LIMIT_EXCEEDED");
          file.terminate();
          return;
        }
        if (isRelevantXml(name)) chunks.push(chunk);
        if (final && isRelevantXml(name)) files.set(name, Buffer.concat(chunks.map((part) => Buffer.from(part))));
      };
      file.start();
    } catch (error) {
      failure = error instanceof Error ? error : new Error("IMPORT_XLSX_INVALID");
    }
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try { unzip.push(buffer, true); } catch { if (!failure) failure = new Error("IMPORT_XLSX_INVALID"); }
  if (failure) throw failure;
  const contentTypes = files.get("[Content_Types].xml")?.toString("utf8") ?? "";
  const workbook = files.get("xl/workbook.xml")?.toString("utf8") ?? "";
  if (!contentTypes || !workbook || !/<(?:\w+:)?workbook(?:\s|>)/.test(workbook)) throw new Error("IMPORT_XLSX_INVALID");
  if (/macroEnabled|vbaProject|externalLink/i.test(contentTypes + workbook)) throw new Error("IMPORT_EXTERNAL_OR_MACRO_CONTENT_REJECTED");
  for (const [name, xmlBuffer] of files) {
    const xml = xmlBuffer.toString("utf8");
    if (/<(?:\w+:)?f(?:\s|>)/i.test(xml)) throw new Error("IMPORT_FORMULA_REJECTED");
    if (name.endsWith(".rels") && /TargetMode\s*=\s*["']External["']/i.test(xml)) throw new Error("IMPORT_EXTERNAL_LINK_REJECTED");
  }
  const sheets = (workbook.match(/<(?:\w+:)?sheet(?:\s|>)/gi) ?? []).length;
  if (sheets < 1 || sheets > IMPORT_LIMITS.sheets) throw new Error("IMPORT_SHEET_LIMIT_EXCEEDED");
  const worksheetNames = [...allNames].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
  if (worksheetNames.length !== sheets) throw new Error("IMPORT_XLSX_INVALID");
  return files;
}

export async function parseXlsx(buffer: Buffer, filename: string): Promise<ParsedSheet[]> {
  if (blockedSpreadsheetExtensions.test(filename)) throw new Error("IMPORT_MACRO_FORMAT_REJECTED");
  if (!/\.xlsx$/i.test(filename)) throw new Error("IMPORT_FORMAT_UNSUPPORTED");
  try {
    const sheets = await parseXlsxInBoundedWorker(buffer);
    if (sheets.length < 1 || sheets.length > IMPORT_LIMITS.sheets) throw new Error("IMPORT_SHEET_LIMIT_EXCEEDED");
    const result = sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows }));
    return result;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("IMPORT_")) throw error;
    throw new Error("IMPORT_XLSX_INVALID");
  }
}

export async function parseInventoryFile(filename: string, buffer: Buffer): Promise<ParsedSheet[]> {
  if (!filename || filename.length > 255 || /[\/\\\u0000-\u001f\u007f]/.test(filename)) throw new Error("IMPORT_FILENAME_INVALID");
  if (buffer.byteLength > IMPORT_LIMITS.fileBytes) throw new Error("IMPORT_FILE_TOO_LARGE");
  if (/\.csv$/i.test(filename)) {
    return [parseCsv(new TextDecoder("utf-8", { fatal: true }).decode(buffer))];
  }
  if (blockedSpreadsheetExtensions.test(filename)) throw new Error("IMPORT_MACRO_FORMAT_REJECTED");
  if (/\.xlsx$/i.test(filename)) return parseXlsx(buffer, filename);
  throw new Error("IMPORT_FORMAT_UNSUPPORTED");
}

export function buildImportMapping(headers: unknown[], mapping: ImportMapping): ImportMapping {
  if (!Array.isArray(headers) || !mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw new Error("IMPORT_MAPPING_INVALID");
  const result: ImportMapping = {};
  const usedColumns = new Set<number>();
  for (const [rawField, column] of Object.entries(mapping)) {
    if (!fieldNames.has(rawField as ImportField) || !Number.isInteger(column) || column! < 0 || column! >= headers.length || usedColumns.has(column!)) {
      throw new Error("IMPORT_MAPPING_INVALID");
    }
    usedColumns.add(column!);
    result[rawField as ImportField] = column;
  }
  if (result.websiteUrl === undefined) throw new Error("IMPORT_DOMAIN_MAPPING_REQUIRED");
  return result;
}

export function parseColumnMapping(fields: Partial<Record<ImportField, string>>): ImportMapping {
  const mapping: ImportMapping = {};
  for (const [field, raw] of Object.entries(fields)) {
    if (!fieldNames.has(field as ImportField)) throw new Error("IMPORT_MAPPING_INVALID");
    if (raw === undefined || raw.trim() === "") continue;
    if (!/^\d{1,2}$/.test(raw.trim())) throw new Error("IMPORT_MAPPING_INVALID");
    mapping[field as ImportField] = Number(raw.trim());
  }
  return mapping;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  if (/^(yes|true|1)$/i.test(value.trim())) return true;
  if (/^(no|false|0)$/i.test(value.trim())) return false;
  return null;
}

export function stageImportRows(options: {
  rows: unknown[][];
  mapping: ImportMapping;
  existingListings: Array<{ id: string; websiteUrl: string }>;
  headerRowNumber?: number;
}): ImportCandidate[] {
  if (!options || typeof options !== "object" || !Array.isArray(options.rows) || !Array.isArray(options.existingListings)) {
    throw new Error("IMPORT_INPUT_INVALID");
  }
  checkGrid(options.rows);
  const headerRowNumber = options.headerRowNumber ?? 1;
  if (!Number.isInteger(headerRowNumber) || headerRowNumber < 1 || headerRowNumber > 100) throw new Error("IMPORT_HEADER_ROW_INVALID");
  const headers = options.rows[headerRowNumber - 1];
  const dataRows = options.rows.slice(headerRowNumber);
  if (!headers || dataRows.length > IMPORT_LIMITS.rowsPerSheet) throw new Error("IMPORT_HEADER_AND_ROWS_REQUIRED");
  const mapping = buildImportMapping(headers, options.mapping);
  const rowDomain = new Map<string, number>();
  const existingByDomain = new Map<string, string[]>();
  for (const listing of options.existingListings) {
    const normalized = normalizeWebsiteUrl(listing.websiteUrl);
    if (!normalized) continue;
    const current = existingByDomain.get(normalized) ?? [];
    current.push(listing.id);
    existingByDomain.set(normalized, current);
  }
  return dataRows.map((row, index) => ({ row, rowNumber: index + headerRowNumber + 1 }))
    .filter(({ row }) => row.some((value) => value !== null && value !== undefined && String(value).trim() !== ""))
    .map(({ row, rowNumber }) => {
    const errors: ImportError[] = [];
    const warnings: string[] = [];
    const values: ImportCandidate["values"] = {};
    for (const [field, column] of Object.entries(mapping) as Array<[ImportField, number]>) {
      let value: unknown;
      try { value = safeCell(row[column]); } catch (error) {
        errors.push({ field, code: error instanceof Error ? error.message : "IMPORT_CELL_INVALID" });
        continue;
      }
      if (value === null || value === "") continue;
      const text = typeof value === "string" ? value.trim() : value;
      switch (field) {
        case "websiteUrl": {
          const bareDomain = typeof text === "string" && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(text);
          const normalized = normalizeWebsiteUrl(bareDomain ? `https://${text}/` : text);
          if (!normalized) errors.push({ field, code: "INVALID_HTTPS_ORIGIN" });
          else values.websiteUrl = normalized;
          break;
        }
        case "categories": {
          const categories = typeof text === "string" ? text.split("|").map((item) => item.trim()) : [];
          if (!categories.length || categories.length > 7 || categories.some((item) => !allowedCategories.has(item)) || new Set(categories).size !== categories.length) errors.push({ field, code: "INVALID_CATEGORIES" });
          else values.categories = categories.join("|");
          break;
        }
        case "primaryLanguage":
          if (typeof text !== "string" || !allowedLanguages.has(text)) errors.push({ field, code: "INVALID_LANGUAGE" });
          else values.primaryLanguage = text;
          break;
        case "linkType":
          if (typeof text !== "string" || !allowedLinkTypes.has(text)) errors.push({ field, code: "INVALID_LINK_TYPE" });
          else values.linkType = text;
          break;
        case "linkValidity":
          if (typeof text !== "string" || !allowedLinkValidities.has(text)) errors.push({ field, code: "INVALID_VALIDITY" });
          else values.linkValidity = text;
          break;
        case "countryCode":
          if (typeof text !== "string" || !/^[A-Z]{2}$/.test(text)) errors.push({ field, code: "INVALID_COUNTRY_CODE" });
          else values.countryCode = text;
          break;
        case "turnaroundDays": {
          const days = typeof text === "number" ? text : typeof text === "string" && /^\d{1,3}$/.test(text) ? Number(text) : NaN;
          if (!Number.isInteger(days) || days < 1 || days > 365) errors.push({ field, code: "INVALID_TURNAROUND" });
          else values.turnaroundDays = days;
          break;
        }
        case "allowsSportsAndGaming": case "allowsPharmacy": case "allowsCrypto": case "allowsForeignLanguage": case "sponsoredContentMarking": {
          const flag = parseBoolean(text);
          if (flag === null) errors.push({ field, code: "INVALID_BOOLEAN" });
          else values[field] = flag;
          break;
        }
        case "title": case "description":
          if (typeof text !== "string" || !text || text.length > (field === "title" ? 120 : 4_000)) errors.push({ field, code: "INVALID_TEXT" });
          else values[field] = text;
          break;
      }
    }
    const websiteUrl = typeof values.websiteUrl === "string" ? values.websiteUrl : null;
    const domain = websiteUrl ? new URL(websiteUrl).hostname : null;
    const previousRow = domain ? rowDomain.get(domain) ?? null : null;
    if (domain && previousRow === null) rowDomain.set(domain, rowNumber);
    const existingIds = websiteUrl ? existingByDomain.get(websiteUrl) ?? [] : [];
    if (existingIds.length || previousRow !== null) warnings.push("POSSIBLE_DUPLICATE_DOMAIN");
    const missing = (["title", "description", "countryCode", "primaryLanguage", "categories", "linkType", "linkValidity", "turnaroundDays", "sponsoredContentMarking"] as const)
      .filter((field) => values[field] === undefined);
    if (missing.length) warnings.push("LISTING_DETAILS_NEED_REVIEW");
    return {
      rowNumber,
      sourceDomain: domain,
      values,
      errors,
      warnings,
      duplicateOfRow: previousRow,
      duplicateOfListingIds: existingIds,
      status: errors.length ? "INVALID" : existingIds.length || previousRow !== null ? "DUPLICATE_REVIEW" : missing.length ? "NEEDS_REVIEW" : "READY",
      duplicateResolution: null,
    };
  });
}

export function resolveDuplicate(candidate: ImportCandidate, resolution: {
  decision: "KEEP_SEPARATE" | "REJECT";
  staffUserId: string;
  reason: string;
  decidedAt: string;
}): ImportCandidate {
  if (candidate.status !== "DUPLICATE_REVIEW") throw new Error("IMPORT_ROW_NOT_DUPLICATE");
  if (!resolution || !["KEEP_SEPARATE", "REJECT"].includes(resolution.decision) || !/^[A-Za-z0-9_-]{1,128}$/.test(resolution.staffUserId) ||
      typeof resolution.reason !== "string" || !resolution.reason.trim() || resolution.reason.length > 1_000 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(resolution.decidedAt) || !Number.isFinite(Date.parse(resolution.decidedAt))) {
    throw new Error("IMPORT_DUPLICATE_DECISION_INVALID");
  }
  if (resolution.decision === "KEEP_SEPARATE") {
    const warnings = candidate.warnings.filter((warning) => warning !== "POSSIBLE_DUPLICATE_DOMAIN");
    return { ...candidate, status: candidate.errors.length ? "INVALID" : warnings.includes("LISTING_DETAILS_NEED_REVIEW") ? "NEEDS_REVIEW" : "READY", warnings, duplicateResolution: resolution };
  }
  return { ...candidate, status: "REJECTED", duplicateResolution: resolution };
}

export function toDraftListingInput(candidate: ImportCandidate): Partial<ListingTerms> & { websiteUrl: string; sourceCostCents: null; status: "DRAFT" } {
  if (candidate.status !== "READY" && candidate.status !== "NEEDS_REVIEW") throw new Error("IMPORT_ROW_NOT_APPLICABLE");
  if (candidate.status === "NEEDS_REVIEW") throw new Error("IMPORT_ROW_INCOMPLETE");
  if (typeof candidate.values.websiteUrl !== "string") throw new Error("IMPORT_DOMAIN_REQUIRED");
  const categories = String(candidate.values.categories).split("|") as ListingCategoryName[];
  return {
    websiteUrl: candidate.values.websiteUrl,
    title: String(candidate.values.title),
    description: String(candidate.values.description),
    countryCode: String(candidate.values.countryCode),
    primaryLanguage: candidate.values.primaryLanguage as ListingLanguage,
    categories,
    sourceCostCents: null,
    linkType: candidate.values.linkType as ListingLinkType,
    linkValidity: candidate.values.linkValidity as ListingLinkValidity,
    turnaroundDays: Number(candidate.values.turnaroundDays),
    allowsSportsAndGaming: typeof candidate.values.allowsSportsAndGaming === "boolean" ? candidate.values.allowsSportsAndGaming : null,
    allowsPharmacy: typeof candidate.values.allowsPharmacy === "boolean" ? candidate.values.allowsPharmacy : null,
    allowsCrypto: typeof candidate.values.allowsCrypto === "boolean" ? candidate.values.allowsCrypto : null,
    allowsForeignLanguage: typeof candidate.values.allowsForeignLanguage === "boolean" ? candidate.values.allowsForeignLanguage : null,
    sponsoredContentMarking: candidate.values.sponsoredContentMarking === true,
    writingEnabled: false,
    writingPriceCents: null,
    writingTurnaroundDays: null,
    writingFirstDraftCents: null,
    writingFinalDraftCents: null,
    buyerRequirements: null,
    status: "DRAFT",
  };
}

export function prepareSelectedRowsForApply(candidates: ImportCandidate[], selectedRowNumbers: number[], role: StaffRole) {
  if (role !== "ADMIN" && role !== "SUPER_ADMIN") throw new Error("IMPORT_APPLY_FORBIDDEN");
  if (!Array.isArray(selectedRowNumbers) || selectedRowNumbers.length < 1 || selectedRowNumbers.length > IMPORT_LIMITS.rowsPerSheet ||
      selectedRowNumbers.some((number) => !Number.isSafeInteger(number)) || new Set(selectedRowNumbers).size !== selectedRowNumbers.length) {
    throw new Error("IMPORT_SELECTION_INVALID");
  }
  const selected = new Set(selectedRowNumbers);
  const byNumber = new Map(candidates.map((candidate) => [candidate.rowNumber, candidate]));
  const results: Array<{ rowNumber: number; listing: ReturnType<typeof toDraftListingInput> }> = [];
  for (const number of selected) {
    const candidate = byNumber.get(number);
    if (!candidate || candidate.status !== "READY") continue;
    results.push({ rowNumber: number, listing: toDraftListingInput(candidate) });
  }
  return results;
}

export function extractPublicSheetReference(input: string): { spreadsheetId: string; gid: string } {
  if (typeof input !== "string" || input.length > 2_048) throw new Error("SHEET_REFERENCE_INVALID");
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("SHEET_REFERENCE_INVALID"); }
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || url.username || url.password || url.port) throw new Error("SHEET_REFERENCE_INVALID");
  if ([...url.searchParams.keys()].some((key) => key !== "gid" && key !== "usp") || url.searchParams.getAll("gid").length > 1 || url.searchParams.getAll("usp").length > 1) {
    throw new Error("SHEET_REFERENCE_INVALID");
  }
  if (url.searchParams.has("usp") && !["sharing", "drive_web"].includes(url.searchParams.get("usp")!)) throw new Error("SHEET_REFERENCE_INVALID");
  if (url.hash && !/^#gid=\d{1,12}$/.test(url.hash)) throw new Error("SHEET_REFERENCE_INVALID");
  const match = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,128})(?:\/.*)?$/.exec(url.pathname);
  if (!match) throw new Error("SHEET_REFERENCE_INVALID");
  const gid = url.searchParams.get("gid") ?? url.hash.match(/gid=(\d{1,12})/)?.[1] ?? "0";
  if (!/^\d{1,12}$/.test(gid)) throw new Error("SHEET_REFERENCE_INVALID");
  const fragmentGid = url.hash.match(/gid=(\d{1,12})/)?.[1];
  if (url.searchParams.has("gid") && fragmentGid && url.searchParams.get("gid") !== fragmentGid) throw new Error("SHEET_REFERENCE_INVALID");
  return { spreadsheetId: match[1], gid };
}

export async function fetchPublicSheetCsv(input: string): Promise<string> {
  const { spreadsheetId, gid } = extractPublicSheetReference(input);
  const endpoint = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
      headers: { Accept: "text/csv" },
    });
  } catch {
    throw new Error("SHEET_FETCH_FAILED");
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!response.ok || mediaType !== "text/csv" || !response.body) {
    await response.body?.cancel();
    throw new Error("SHEET_FETCH_FAILED");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > IMPORT_LIMITS.fileBytes) throw new Error("SHEET_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } catch {
    throw new Error("SHEET_FETCH_FAILED");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}
