import { requireStaffAccess } from "@/server/auth/staff";
import { stageInventoryImport } from "@/server/catalog/imports";
import { IMPORT_LIMITS, parseColumnMapping, type ImportField, type ImportMapping } from "@/modules/catalog/imports";

const maxRequestBytes = 11 * 1024 * 1024;
const mappingFields: readonly ImportField[] = [
  "websiteUrl", "title", "description", "countryCode", "primaryLanguage", "categories",
  "linkType", "linkValidity", "turnaroundDays", "allowsSportsAndGaming", "allowsPharmacy", "allowsCrypto",
  "allowsForeignLanguage", "sponsoredContentMarking",
];

async function readBoundedFormData(request: Request): Promise<FormData | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxRequestBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Request(request.url, {
    method: "POST",
    headers,
    body: Buffer.concat(chunks),
  }).formData();
}

function redirectToStaff(path: string) {
  const base = process.env.STAFF_APP_URL;
  if (!base) return new Response("Staff origin is not configured", { status: 500 });
  return Response.redirect(new URL(path, base), 303);
}

export async function POST(request: Request) {
  try {
    await requireStaffAccess(request.headers, "supplier.manage");
    const origin = request.headers.get("origin");
    const staffOrigin = process.env.STAFF_APP_URL;
    if (!origin || !staffOrigin || new URL(origin).origin !== new URL(staffOrigin).origin) {
      return new Response("Forbidden", { status: 403 });
    }
    const contentLength = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > maxRequestBytes) {
      return redirectToStaff("/staff/suppliers/imports?error=size");
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
      return new Response("Unsupported media type", { status: 415 });
    }
    const form = await readBoundedFormData(request);
    if (!form) return redirectToStaff("/staff/suppliers/imports?error=size");
    const supplierId = form.get("supplierId");
    const sourceType = form.get("sourceType");
    if (typeof supplierId !== "string" || !["CSV", "XLSX", "GOOGLE_SHEETS"].includes(String(sourceType))) {
      return redirectToStaff("/staff/suppliers/imports?error=invalid");
    }
    const fields: Record<string, string> = {};
    for (const field of mappingFields) {
      const value = form.get(field);
      if (typeof value === "string") fields[field] = value;
    }
    let mapping: ImportMapping;
    try { mapping = parseColumnMapping(fields); } catch { return redirectToStaff("/staff/suppliers/imports?error=mapping"); }
    let result: { batchId: string; rowCount: number };
    if (sourceType === "GOOGLE_SHEETS") {
      const reference = form.get("sheetReference");
      if (typeof reference !== "string") return redirectToStaff("/staff/suppliers/imports?error=source");
      result = await stageInventoryImport(request.headers, { supplierId, sourceType, sheetReference: reference, mapping });
    } else {
      const file = form.get("file");
      if (!(file instanceof File) || file.size < 1 || file.size > IMPORT_LIMITS.fileBytes) return redirectToStaff("/staff/suppliers/imports?error=file");
      const sheetIndexRaw = form.get("sheetIndex");
      const sheetIndex = typeof sheetIndexRaw === "string" && /^\d{1,2}$/.test(sheetIndexRaw) ? Number(sheetIndexRaw) : 0;
      result = await stageInventoryImport(request.headers, {
        supplierId, sourceType: sourceType as "CSV" | "XLSX",
        file: { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, sheetIndex, mapping,
      });
    }
    return redirectToStaff(`/staff/suppliers/imports/${result.batchId}?staged=${result.rowCount}`);
  } catch (error) {
    if (error instanceof Error && error.message === "IMPORT_XLSX_PARSER_BUSY") {
      return redirectToStaff("/staff/suppliers/imports?error=busy");
    }
    return redirectToStaff("/staff/suppliers/imports?error=stage");
  }
}
