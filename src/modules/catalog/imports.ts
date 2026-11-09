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
import { normalizeWebsiteUrl, normalizeWebsiteUrlLookupKey, type ListingTerms, type StaffRole } from "./domain.ts";

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

export function listingWebsiteUrlLookupKeys(values: readonly unknown[]): string[] {
  return [...new Set(values.flatMap((value) => {
    const key = normalizeWebsiteUrlLookupKey(value);
    return key ? [key] : [];
  }))].sort();
}

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
const allowedLanguages = new Set<string>(LISTING_LANGUAGES);
const allowedLinkTypes = new Set<string>(LISTING_LINK_TYPES);
const allowedLinkValidities = new Set<string>(LISTING_LINK_VALIDITIES);
const headerAliases: Record<ImportField, string[]> = {
  websiteUrl: ["website", "website url", "website address", "site", "site url", "site address", "url", "domain", "domain name", "publisher url", "guest post site", "guest post sites list"],
  title: ["title", "listing title", "site title", "site name", "website name", "publication name"],
  description: ["description", "listing description", "site description", "website description"],
  countryCode: ["country", "country code", "country region", "region", "geo", "geography"],
  primaryLanguage: ["language", "primary language", "content language", "article language"],
  categories: ["category", "categories", "niche", "niches", "website niche", "websites niche", "website niches", "websites niches", "site niche", "site niches"],
  linkType: ["link type", "link attribute", "link rel", "link relation", "post link type"],
  linkValidity: ["link validity", "placement term", "link term", "link duration", "placement duration", "link permanence"],
  turnaroundDays: ["turnaround", "turnaround time", "turnaround days", "tat", "tat publish time", "publish time", "delivery time", "delivery days"],
  allowsSportsAndGaming: ["sports and gaming", "sports and gaming allowed", "sports gaming accepted", "sports and gaming accepted"],
  allowsPharmacy: ["pharmacy", "pharmacy allowed", "pharmacy accepted"],
  allowsCrypto: ["crypto", "crypto allowed", "crypto accepted"],
  allowsForeignLanguage: ["foreign language", "foreign language allowed", "foreign language accepted"],
  sponsoredContentMarking: ["sponsored marking", "sponsored content marking", "sponsored tag", "sponsored content tag"],
};
const normalizedHeaders = new Map<string, ImportField>();
for (const [field, aliases] of Object.entries(headerAliases) as Array<[ImportField, string[]]>) {
  for (const alias of aliases) normalizedHeaders.set(normalizeImportText(alias), field);
}
const categoryAliases = new Map<string, string>([
  ["news", "News, Media & Magazines"],
  ["tech", "Technology & Gadgets"],
]);
const categoriesByKey = new Map(LISTING_CATEGORY_NAMES.map((category) => [normalizeImportText(category), category]));
const maxCategoryPartChars = Math.max(...LISTING_CATEGORY_NAMES.map((category) => category.length), ...[...categoryAliases.keys()].map((alias) => alias.length)) + 16;
const formulas = /^[\s\u0000-\u0020]*[=+\-@]/;
const blockedSpreadsheetExtensions = /\.(?:xlsm|xltm|xlsb|xls|xlam|xla)$/i;
const XLSX_PARSER_WORKER = `
  const { parentPort, workerData } = require("node:worker_threads");
  const { createRequire } = require("node:module");
  const { resolve } = require("node:path");
  const requireFromProject = createRequire(resolve(process.cwd(), "package.json"));
  const { Unzip, UnzipInflate, UnzipPassThrough } = requireFromProject("fflate");
  const readXlsxFile = requireFromProject("read-excel-file/node");
  const { Parser } = requireFromProject("saxen");
  const IMPORT_LIMITS = ${JSON.stringify(IMPORT_LIMITS)};
  const formulas = /^[\s\u0000-\u0020]*[=+\-@]/;
  const assertSafeArchivePath = (${assertSafeArchivePath.toString()});
  const inspectXml = (${inspectXml.toString()});
  const inspectXlsxArchive = (${inspectXlsxArchive.toString()});
  const safeCell = (${safeCell.toString()});
  const checkGrid = (${checkGrid.toString()});
  const buffer = Buffer.from(workerData);
  try {
    inspectXlsxArchive(buffer, Parser);
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

type XlsxXmlParser = new () => {
  on(event: "error", handler: () => void): void;
  on(event: "openTag", handler: (
    name: string, getAttributes: () => Record<string, string>, decode: (value: string) => string,
  ) => void): void;
  parse(xml: string): void;
};

function inspectXml(
  Parser: XlsxXmlParser,
  xml: Buffer,
  onTag: (name: string, attributes: Record<string, string>) => void,
) {
  const parser = new Parser();
  parser.on("error", () => { throw new Error("IMPORT_XLSX_INVALID"); });
  parser.on("openTag", (name, getAttributes, decode) => {
    const attributes: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(getAttributes())) {
      if (key === "xmlns" || key.startsWith("xmlns:")) continue;
      const localName = key.split(":").at(-1)!;
      if (Object.hasOwn(attributes, localName)) throw new Error("IMPORT_XLSX_INVALID");
      attributes[localName] = decode(value);
    }
    onTag(name.split(":").at(-1)!, attributes);
  });
  parser.parse(xml.toString("utf8"));
}

function inspectXlsxArchive(buffer: Buffer, Parser: XlsxXmlParser) {
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
        chunks.push(chunk);
        if (final) files.set(name, Buffer.concat(chunks));
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
  const contentTypes = files.get("[Content_Types].xml")?.toString("utf8");
  const workbook = files.get("xl/workbook.xml");
  if (!contentTypes || !workbook) throw new Error("IMPORT_XLSX_INVALID");
  if (/macroEnabled|vbaProject|externalLink/i.test(contentTypes + workbook.toString("utf8"))) {
    throw new Error("IMPORT_EXTERNAL_OR_MACRO_CONTENT_REJECTED");
  }

  const worksheetPaths = new Map<string, string>();
  for (const [path, xml] of files) {
    if (!path.endsWith(".rels")) continue;
    inspectXml(Parser, xml, (name, attributes) => {
      if (name !== "Relationship") return;
      if (attributes.TargetMode?.toLowerCase() === "external") throw new Error("IMPORT_EXTERNAL_LINK_REJECTED");
      if (path !== "xl/_rels/workbook.xml.rels" || !/^(http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006|http:\/\/purl\.oclc\.org\/ooxml\/officeDocument)\/relationships\/worksheet$/.test(attributes.Type ?? "")) return;
      const { Id, Target } = attributes;
      if (!Id || !Target || worksheetPaths.has(Id)) throw new Error("IMPORT_XLSX_INVALID");
      const targetPath = Target.startsWith("/") ? Target.slice(1) : `xl/${Target}`;
      assertSafeArchivePath(targetPath);
      worksheetPaths.set(Id, targetPath);
    });
  }
  const sheetIds: string[] = [];
  inspectXml(Parser, workbook, (name, attributes) => {
    if (name === "sheet") sheetIds.push(attributes.id);
  });
  if (sheetIds.length < 1 || sheetIds.length > IMPORT_LIMITS.sheets) throw new Error("IMPORT_SHEET_LIMIT_EXCEEDED");
  for (const id of sheetIds) {
    const path = worksheetPaths.get(id);
    const worksheet = path && files.get(path);
    if (!worksheet) throw new Error("IMPORT_XLSX_INVALID");
    inspectXml(Parser, worksheet, (name) => {
      if (name === "f") throw new Error("IMPORT_FORMULA_REJECTED");
    });
  }
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

function normalizeImportText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim() : "";
}

export type ImportMappingSuggestion = {
  headerRowNumber: number;
  mapping: ImportMapping;
  recognizedFields: ImportField[];
  ambiguousFields: ImportField[];
};

/**
 * Suggest a 1-based header row and only exact, known column-name mappings.
 * Unrecognized columns stay unmapped; callers retain the manual mapping path.
 */
export function suggestImportMapping(rows: unknown[][]): ImportMappingSuggestion {
  if (!Array.isArray(rows)) throw new Error("IMPORT_INPUT_INVALID");
  const scanCount = Math.min(rows.length, 100);
  let best: ImportMappingSuggestion = { headerRowNumber: 1, mapping: {}, recognizedFields: [], ambiguousFields: [] };
  let bestScore = 0;
  for (let rowIndex = 0; rowIndex < scanCount; rowIndex++) {
    const row = rows[rowIndex];
    if (!Array.isArray(row)) continue;
    const columnsByField = new Map<ImportField, number[]>();
    for (let column = 0; column < row.length; column++) {
      const header = normalizeImportText(row[column]);
      const field = normalizedHeaders.get(header);
      if (!field) continue;
      const columns = columnsByField.get(field) ?? [];
      columns.push(column);
      columnsByField.set(field, columns);
    }
    const mapping: ImportMapping = {};
    const ambiguousFields: ImportField[] = [];
    for (const [field, columns] of columnsByField) {
      if (columns.length === 1) mapping[field] = columns[0];
      else ambiguousFields.push(field);
    }
    const recognizedFields = Object.keys(mapping) as ImportField[];
    const score = recognizedFields.length + (mapping.websiteUrl === undefined ? 0 : 4) - ambiguousFields.length;
    if (score > bestScore) {
      bestScore = score;
      best = { headerRowNumber: rowIndex + 1, mapping, recognizedFields, ambiguousFields };
    }
  }
  return best;
}

function parseBoolean(value: unknown, header: unknown, field: ImportField): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = normalizeImportText(value);
  if (["yes", "true", "1"].includes(normalized)) return true;
  if (["no", "false", "0"].includes(normalized)) return false;
  const headerField = normalizedHeaders.get(normalizeImportText(header));
  if (headerField === field && ["allowed", "accepted"].includes(normalized)) return true;
  if (headerField === field && ["not allowed", "not accepted", "disallowed", "rejected"].includes(normalized)) return false;
  return null;
}

function normalizeCategoryValues(value: string): string[] | null {
  const categoryFor = (part: string) => categoriesByKey.get(normalizeImportText(part)) ?? categoryAliases.get(normalizeImportText(part));
  const whole = categoryFor(value);
  if (whole) return [whole];

  const parseDelimitedFragment = (fragment: string): string[] | null => {
    const remaining = fragment.trim();
    if (!remaining) return null;
    const result: string[] = [];
    let offset = 0;
    while (offset < remaining.length) {
      const tail = remaining.slice(offset).trimStart();
      if (!tail) return null;
      const leadingSpace = remaining.slice(offset).length - tail.length;
      const separatorEnds: number[] = [];
      const candidateLimit = Math.min(tail.length, maxCategoryPartChars);
      for (let index = 0; index < candidateLimit; index++) if (/[,/;]/.test(tail[index])) separatorEnds.push(index);
      if (tail.length <= maxCategoryPartChars) separatorEnds.push(tail.length);
      let best: { end: number; category: string } | null = null;
      for (const end of separatorEnds) {
        const category = categoryFor(tail.slice(0, end).trim());
        if (category && (!best || end > best.end)) best = { end, category };
      }
      if (!best) return null;
      result.push(best.category);
      if (result.length > 7) return null;
      const consumed = leadingSpace + best.end;
      const after = offset + consumed;
      if (after >= remaining.length) break;
      if (!/[,/;]/.test(remaining[after])) return null;
      offset = after + 1;
    }
    return result;
  };

  const categories: string[] = [];
  for (const fragment of value.split("|")) {
    const parsed = parseDelimitedFragment(fragment);
    if (!parsed) return null;
    categories.push(...parsed);
  }
  if (!categories.length || categories.length > 7 || new Set(categories).size !== categories.length) return null;
  return categories;
}

function normalizeEnumValue(value: unknown, allowed: Set<string>): string | null {
  const normalized = normalizeImportText(value);
  for (const candidate of allowed) if (normalizeImportText(candidate) === normalized) return candidate;
  return null;
}

function suggestNewMarkerDomain(value: string): string | null {
  const match = /^((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})\s+new$/i.exec(value.trim());
  return match ? normalizeWebsiteUrl(`https://${match[1]}/`) : null;
}

function hasReviewWarning(warnings: string[]): boolean {
  return warnings.some((warning) => warning === "LISTING_DETAILS_NEED_REVIEW" || warning === "WEBSITE_NEW_MARKER_CONFIRMATION_REQUIRED" ||
    warning === "CATEGORY_ROW_MAPPING_REQUIRED" || warning.startsWith("FIELD_VALUE_NEEDS_REVIEW:") || warning.endsWith("_REVIEW_REQUIRED"));
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
  const existingByUrlKey = new Map<string, string[]>();
  for (const listing of options.existingListings) {
    const lookupKey = normalizeWebsiteUrlLookupKey(listing.websiteUrl);
    if (!lookupKey) continue;
    const current = existingByUrlKey.get(lookupKey) ?? [];
    current.push(listing.id);
    existingByUrlKey.set(lookupKey, current);
  }
  return dataRows.map((row, index) => ({ row, rowNumber: index + headerRowNumber + 1 }))
    .filter(({ row }) => row.some((value) => value !== null && value !== undefined && String(value).trim() !== ""))
    .map(({ row, rowNumber }) => {
    const errors: ImportError[] = [];
    const warnings: string[] = [];
    const values: ImportCandidate["values"] = {};
    for (const [field, column] of Object.entries(mapping) as Array<[ImportField, number]>) {
      const header = headers[column];
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
          if (normalized) values.websiteUrl = normalized;
          else {
            const markerSuggestion = typeof text === "string" ? suggestNewMarkerDomain(text) : null;
            if (markerSuggestion) {
              values.websiteUrl = markerSuggestion;
              warnings.push("WEBSITE_NEW_MARKER_CONFIRMATION_REQUIRED");
            } else errors.push({ field, code: "INVALID_HTTPS_ORIGIN" });
          }
          break;
        }
        case "categories": {
          const sourceCategory = typeof text === "string" ? text : "";
          const categories = normalizeCategoryValues(sourceCategory);
          if (!categories) warnings.push(`FIELD_VALUE_NEEDS_REVIEW:${field}`);
          else warnings.push("CATEGORY_ROW_MAPPING_REQUIRED");
          break;
        }
        case "primaryLanguage": {
          const language = normalizeEnumValue(text, allowedLanguages);
          if (!language) warnings.push(`FIELD_VALUE_NEEDS_REVIEW:${field}`);
          else values.primaryLanguage = language as ListingLanguage;
          break;
        }
        case "linkType": {
          const linkType = normalizeEnumValue(text, allowedLinkTypes);
          if (!linkType) warnings.push(`FIELD_VALUE_NEEDS_REVIEW:${field}`);
          else values.linkType = linkType as ListingLinkType;
          break;
        }
        case "linkValidity": {
          const validity = normalizeEnumValue(text, allowedLinkValidities);
          if (!validity) warnings.push(`FIELD_VALUE_NEEDS_REVIEW:${field}`);
          else values.linkValidity = validity as ListingLinkValidity;
          break;
        }
        case "countryCode": {
          const countryCode = typeof text === "string" ? text.trim().toUpperCase() : "";
          if (!/^[A-Z]{2}$/.test(countryCode)) warnings.push(`FIELD_VALUE_NEEDS_REVIEW:${field}`);
          else values.countryCode = countryCode;
          break;
        }
        case "turnaroundDays": {
          const normalized = normalizeImportText(text);
          const instant = normalized === "instant";
          const days = instant ? 1 : typeof text === "number" ? text : typeof text === "string" && /^\d{1,3}$/.test(text) ? Number(text) : NaN;
          if (!Number.isInteger(days) || days < 1 || days > 365) warnings.push(`FIELD_VALUE_NEEDS_REVIEW:${field}`);
          else {
            values.turnaroundDays = days;
            if (instant) warnings.push("TURNAROUND_INSTANT_REVIEW_REQUIRED");
          }
          break;
        }
        case "allowsSportsAndGaming": case "allowsPharmacy": case "allowsCrypto": case "allowsForeignLanguage": case "sponsoredContentMarking": {
          const flag = parseBoolean(text, header, field);
          if (flag === null) warnings.push(`FIELD_VALUE_NEEDS_REVIEW:${field}`);
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
    const lookupKey = websiteUrl ? normalizeWebsiteUrlLookupKey(websiteUrl) : null;
    const existingIds = lookupKey ? existingByUrlKey.get(lookupKey) ?? [] : [];
    if (existingIds.length || previousRow !== null) warnings.push("POSSIBLE_DUPLICATE_DOMAIN");
    const missing = (["title", "description", "countryCode", "primaryLanguage", "categories", "linkType", "linkValidity", "turnaroundDays", "sponsoredContentMarking"] as const)
      .filter((field) => values[field] === undefined);
    if (missing.length) warnings.push("LISTING_DETAILS_NEED_REVIEW");
    const unresolved = hasReviewWarning(warnings);
    return {
      rowNumber,
      sourceDomain: domain,
      values,
      errors,
      warnings,
      duplicateOfRow: previousRow,
      duplicateOfListingIds: existingIds,
      status: errors.length ? "INVALID" : existingIds.length || previousRow !== null ? "DUPLICATE_REVIEW" : missing.length || unresolved ? "NEEDS_REVIEW" : "READY",
      duplicateResolution: null,
    };
  });
}

export function applyPlatformCategoryOverride(candidate: ImportCandidate, categories: string[]): ImportCandidate {
  const values = { ...candidate.values };
  const errors = candidate.errors.filter((error) => error.field !== "categories");
  const warnings = candidate.warnings.filter((warning) => warning !== "FIELD_VALUE_NEEDS_REVIEW:categories" && warning !== "CATEGORY_ROW_MAPPING_REQUIRED" &&
    warning !== "CATEGORY_MAPPING_CONFIRMATION_REQUIRED" && warning !== "CATEGORY_ALIAS_REVIEW_REQUIRED");
  values.categories = categories.join("|");
  const missing = (["title", "description", "countryCode", "primaryLanguage", "categories", "linkType", "linkValidity", "turnaroundDays", "sponsoredContentMarking"] as const)
    .filter((field) => values[field] === undefined);
  const existingMissingWarning = warnings.includes("LISTING_DETAILS_NEED_REVIEW");
  if (missing.length && !existingMissingWarning) warnings.push("LISTING_DETAILS_NEED_REVIEW");
  if (!missing.length && existingMissingWarning) warnings.splice(warnings.indexOf("LISTING_DETAILS_NEED_REVIEW"), 1);
  const duplicate = candidate.duplicateOfListingIds.length > 0 || candidate.duplicateOfRow !== null;
  const unresolved = hasReviewWarning(warnings);
  return {
    ...candidate, values, errors, warnings,
    status: errors.length ? "INVALID" : duplicate ? "DUPLICATE_REVIEW" : missing.length || unresolved ? "NEEDS_REVIEW" : "READY",
  };
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
    return { ...candidate, status: candidate.errors.length ? "INVALID" : hasReviewWarning(warnings) ? "NEEDS_REVIEW" : "READY", warnings, duplicateResolution: resolution };
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
  if ([...url.searchParams.keys()].some((key) => !["gid", "usp", "pli"].includes(key)) || url.searchParams.getAll("gid").length > 1 || url.searchParams.getAll("usp").length > 1 || url.searchParams.getAll("pli").length > 1) {
    throw new Error("SHEET_REFERENCE_INVALID");
  }
  if (url.searchParams.has("usp") && !["sharing", "drive_web"].includes(url.searchParams.get("usp")!)) throw new Error("SHEET_REFERENCE_INVALID");
  if (url.searchParams.has("pli") && url.searchParams.get("pli") !== "1") throw new Error("SHEET_REFERENCE_INVALID");
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
  const endpoint = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`);
  let currentUrl = endpoint;
  let response: Response | undefined;
  const signal = AbortSignal.timeout(15_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    try {
      response = await fetch(currentUrl, {
        method: "GET", redirect: "manual", cache: "no-store", signal,
        headers: { Accept: "text/csv" },
      });
    } catch {
      throw new Error("SHEET_FETCH_FAILED");
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects === 3) throw new Error("SHEET_FETCH_FAILED");
    let nextUrl: URL;
    try { nextUrl = new URL(location, currentUrl); } catch { throw new Error("SHEET_FETCH_FAILED"); }
    const allowedHost = nextUrl.hostname === "docs.google.com" || nextUrl.hostname === "googleusercontent.com" || nextUrl.hostname.endsWith(".googleusercontent.com");
    if (nextUrl.protocol !== "https:" || nextUrl.username || nextUrl.password || nextUrl.port || !allowedHost) {
      throw new Error("SHEET_FETCH_FAILED");
    }
    currentUrl = nextUrl;
  }
  if (!response) throw new Error("SHEET_FETCH_FAILED");
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new Error("SHEET_ACCESS_DENIED");
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("SHEET_FETCH_FAILED");
  }
  if (mediaType !== "text/csv") {
    await response.body.cancel();
    throw new Error("SHEET_EXPORT_UNAVAILABLE");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > IMPORT_LIMITS.fileBytes) {
        await reader.cancel();
        throw new Error("SHEET_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "SHEET_RESPONSE_TOO_LARGE") throw error;
    throw new Error("SHEET_FETCH_FAILED");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new Error("SHEET_EXPORT_UNAVAILABLE"); }
}
