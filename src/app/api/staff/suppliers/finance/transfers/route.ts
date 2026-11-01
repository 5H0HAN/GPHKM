import { recordSupplierTransfer } from "@/server/catalog/supplier-finance";
import { requireStaffAccess } from "@/server/auth/staff";
import { validSupplierTransferEvidence } from "@/modules/supplier-finance/validation";

export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024;

function redirectToFinance(listingPage: string, page: string, transferPage: string, coveragePage: string, search: string, result: "saved" | "error") {
  const staffUrl = process.env.STAFF_APP_URL;
  if (!staffUrl) return new Response("Staff origin is not configured", { status: 500 });
  const params = new URLSearchParams({
    [result === "saved" ? "saved" : "error"]: result === "saved" ? "transfer" : "payment",
    listingsPage: listingPage,
    orderItemsPage: page,
    transfersPage: transferPage,
    coveragePage,
  });
  if (search) params.set("q", search);
  const target = new URL(`/staff/suppliers/finance?${params.toString()}`, staffUrl);
  return Response.redirect(target, 303);
}

function field(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  let listingPage = "1";
  let page = "1";
  let transferPage = "1";
  let coveragePage = "1";
  let search = "";
  try {
    await requireStaffAccess(request.headers, "costs.read");
    const origin = request.headers.get("origin");
    const staffOrigin = process.env.STAFF_APP_URL;
    if (!origin || !staffOrigin || new URL(origin).origin !== new URL(staffOrigin).origin) return new Response("Forbidden", { status: 403 });
    const length = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_REQUEST_BYTES) return redirectToFinance(listingPage, page, transferPage, coveragePage, search, "error");
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) return new Response("Unsupported media type", { status: 415 });

    const form = await request.formData();
    listingPage = /^[1-9]\d{0,5}$/.test(field(form, "listingsPage")) ? field(form, "listingsPage") : "1";
    page = /^[1-9]\d{0,5}$/.test(field(form, "orderItemsPage")) ? field(form, "orderItemsPage") : "1";
    transferPage = /^[1-9]\d{0,5}$/.test(field(form, "transfersPage")) ? field(form, "transfersPage") : "1";
    coveragePage = /^[1-9]\d{0,5}$/.test(field(form, "coveragePage")) ? field(form, "coveragePage") : "1";
    search = field(form, "q").slice(0, 100);
    let rawAllocations: unknown;
    try { rawAllocations = JSON.parse(field(form, "allocationsJson")); } catch { return redirectToFinance(listingPage, page, transferPage, coveragePage, search, "error"); }
    if (!Array.isArray(rawAllocations) || rawAllocations.length > 100 || rawAllocations.some((entry) =>
      typeof entry !== "object" || entry === null || !("orderItemId" in entry) || !("amount" in entry) ||
      typeof entry.orderItemId !== "string" || typeof entry.amount !== "string")) return redirectToFinance(listingPage, page, transferPage, coveragePage, search, "error");

    const file = form.get("evidenceFile");
    if (!(file instanceof File) || file.size < 1 || file.size > MAX_FILE_BYTES) return redirectToFinance(listingPage, page, transferPage, coveragePage, search, "error");
    const extension = file.name.toLowerCase().split(".").at(-1);
    if (extension !== "eml" && extension !== "pdf") return redirectToFinance(listingPage, page, transferPage, coveragePage, search, "error");
    const bytes = Buffer.from(await file.arrayBuffer());
    const kind = extension === "pdf" ? "PDF" : "EML";
    if (!validSupplierTransferEvidence(kind, bytes)) return redirectToFinance(listingPage, page, transferPage, coveragePage, search, "error");

    await recordSupplierTransfer(request.headers, {
      supplierId: field(form, "supplierId"), allocations: rawAllocations,
      amount: field(form, "amount"), date: field(form, "date"), transferReference: field(form, "transferReference"),
      evidenceReference: field(form, "evidenceReference"), reason: field(form, "reason"), idempotencyKey: field(form, "idempotencyKey"),
      evidence: { kind, bytes },
    });
    return redirectToFinance(listingPage, page, transferPage, coveragePage, search, "saved");
  } catch {
    return redirectToFinance(listingPage, page, transferPage, coveragePage, search, "error");
  }
}
