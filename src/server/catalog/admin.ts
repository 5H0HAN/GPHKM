import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { listing, listingRevision, listingSourcing, listingUrl, supplier, supplierContact } from "@/db/catalog-schema";
import { requireStaffAccess } from "@/server/auth/staff";
import { appendAuditEvent } from "@/server/audit/append";
import { canTransitionListing, normalizeWebsiteUrl, validateListingRelationships, validateListingTerms, validatePublishableListing, type CommercialSource, type ListingStatus, type ListingTerms } from "@/modules/catalog/domain";
import { staffCatalogPagination } from "@/modules/catalog/pagination";

export async function staffTransaction<T>(headers: Headers, permission: "catalog.manage" | "supplier.manage" | "costs.read", work: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], userId: string, role: string) => Promise<T>): Promise<T> {
  const actor = await requireStaffAccess(headers, permission);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    return work(tx, actor.userId, actor.role);
  });
}

export type NewListingInput = {
  terms: ListingTerms;
  commercialSource: CommercialSource;
  supplierId: string | null;
  fulfillmentSupplierId: string | null;
  urlVisibleWithoutRecharge: boolean;
};

export async function insertDraftListingInTransaction(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], userId: string, input: NewListingInput) {
  const websiteUrl = normalizeWebsiteUrl(input.terms.websiteUrl);
  if (!websiteUrl) throw new Error("Invalid listing URL");
  const terms = { ...input.terms, websiteUrl };
  const termErrors = validateListingTerms(terms);
  const relationshipErrors = validateListingRelationships(input.commercialSource, input.supplierId, input.fulfillmentSupplierId);
  if (termErrors.length || relationshipErrors.length) throw new Error("Invalid listing fields");
  const domain = new URL(websiteUrl).hostname;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${domain}, 0))`);
  for (const supplierId of [input.supplierId, input.fulfillmentSupplierId].filter((value): value is string => value !== null)) {
    const [found] = await tx.select({ id: supplier.id }).from(supplier).where(eq(supplier.id, supplierId)).limit(1);
    if (!found) throw new Error("Supplier unavailable");
  }
  const id = randomUUID();
  await tx.insert(listing).values({
    id, title: terms.title.trim(), description: terms.description.trim(), countryCode: terms.countryCode,
    primaryLanguage: terms.primaryLanguage, categories: terms.categories, retailPriceCents: String(terms.retailPriceCents),
    linkType: terms.linkType, linkValidity: terms.linkValidity, turnaroundDays: terms.turnaroundDays,
    allowsSportsAndGaming: terms.allowsSportsAndGaming, allowsPharmacy: terms.allowsPharmacy,
    allowsCrypto: terms.allowsCrypto, allowsForeignLanguage: terms.allowsForeignLanguage,
    sponsoredContentMarking: terms.sponsoredContentMarking, writingEnabled: terms.writingEnabled,
    writingPriceCents: terms.writingPriceCents === null ? null : String(terms.writingPriceCents),
    writingTurnaroundDays: terms.writingTurnaroundDays,
    writingFirstDraftCents: terms.writingFirstDraftCents === null ? null : String(terms.writingFirstDraftCents),
    writingFinalDraftCents: terms.writingFinalDraftCents === null ? null : String(terms.writingFinalDraftCents),
    buyerRequirements: terms.buyerRequirements?.trim() || null, status: "DRAFT",
  });
  await tx.insert(listingSourcing).values({ listingId: id, commercialSource: input.commercialSource, supplierId: input.supplierId, fulfillmentSupplierId: input.fulfillmentSupplierId, urlVisibleWithoutRecharge: input.urlVisibleWithoutRecharge, createdByUserId: userId });
  await tx.insert(listingUrl).values({ listingId: id, websiteUrl: terms.websiteUrl });
  await tx.insert(listingRevision).values({ listingId: id, revision: 1, terms: { ...terms }, actorUserId: userId, reason: "Initial listing draft" });
  await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_LISTING_CREATED", targetType: "marketplace_listing", targetId: id, metadata: { version: 1 } });
  return { id };
}

export async function createDraftListing(headers: Headers, input: NewListingInput) {
  return staffTransaction(headers, "catalog.manage", (tx, userId) => insertDraftListingInTransaction(tx, userId, input));
}

export async function transitionListing(headers: Headers, id: string, next: ListingStatus) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Listing unavailable");
  return staffTransaction(headers, "catalog.manage", async (tx, userId) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('gphkm:catalog-listing:' || ${id}, 0))`);
    const [row] = await tx.select().from(listing).where(eq(listing.id, id)).for("update").limit(1);
    if (!row || !canTransitionListing(row.status, next, "ADMIN")) throw new Error("Invalid listing transition");
    const [source] = await tx.select().from(listingSourcing).where(eq(listingSourcing.listingId, id)).limit(1);
    const [url] = await tx.select({ websiteUrl: listingUrl.websiteUrl }).from(listingUrl).where(eq(listingUrl.listingId, id)).limit(1);
    if (!source || !url) throw new Error("Listing is incomplete");
    const terms: ListingTerms = {
      title: row.title, description: row.description, websiteUrl: url.websiteUrl, countryCode: row.countryCode,
      primaryLanguage: row.primaryLanguage as ListingTerms["primaryLanguage"], categories: row.categories as ListingTerms["categories"],
      retailPriceCents: Number(row.retailPriceCents), linkType: row.linkType as ListingTerms["linkType"],
      linkValidity: row.linkValidity as ListingTerms["linkValidity"], turnaroundDays: row.turnaroundDays,
      allowsSportsAndGaming: row.allowsSportsAndGaming, allowsPharmacy: row.allowsPharmacy, allowsCrypto: row.allowsCrypto,
      allowsForeignLanguage: row.allowsForeignLanguage, sponsoredContentMarking: row.sponsoredContentMarking,
      writingEnabled: row.writingEnabled, writingPriceCents: row.writingPriceCents === null ? null : Number(row.writingPriceCents),
      writingTurnaroundDays: row.writingTurnaroundDays, writingFirstDraftCents: row.writingFirstDraftCents === null ? null : Number(row.writingFirstDraftCents),
      writingFinalDraftCents: row.writingFinalDraftCents === null ? null : Number(row.writingFinalDraftCents), buyerRequirements: row.buyerRequirements,
    };
    if (next === "LIVE") {
      const errors = validatePublishableListing({ ...terms, id, revision: row.revision, status: row.status, commercialSource: source.commercialSource,
        supplierId: source.supplierId, fulfillmentSupplierId: source.fulfillmentSupplierId, sourceCostCents: null,
        urlVisibleWithoutRecharge: source.urlVisibleWithoutRecharge, metrics: [], createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
      if (errors.length) throw new Error("Listing is not ready to publish");
    }
    const revision = row.revision + 1;
    await tx.update(listing).set({ status: next, revision, updatedAt: new Date() }).where(eq(listing.id, id));
    await tx.insert(listingRevision).values({ listingId: id, revision, terms: { ...terms }, actorUserId: userId, reason: `Status changed to ${next}` });
    await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_LISTING_STATUS_CHANGED", targetType: "marketplace_listing", targetId: id, metadata: { fromState: row.status, toState: next, version: revision } });
    return { id, status: next };
  });
}

export async function getStaffListingForEdit(headers: Headers, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Listing unavailable");
  return staffTransaction(headers, "catalog.manage", async (tx) => {
    const [row] = await tx.select({
      listing, source: listingSourcing, websiteUrl: listingUrl.websiteUrl,
    }).from(listing)
      .innerJoin(listingSourcing, eq(listingSourcing.listingId, listing.id))
      .innerJoin(listingUrl, eq(listingUrl.listingId, listing.id))
      .where(eq(listing.id, id)).limit(1);
    if (!row) throw new Error("Listing unavailable");
    return {
      id: row.listing.id,
      revision: row.listing.revision,
      status: row.listing.status,
      terms: {
        title: row.listing.title, description: row.listing.description, websiteUrl: row.websiteUrl,
        countryCode: row.listing.countryCode, primaryLanguage: row.listing.primaryLanguage as ListingTerms["primaryLanguage"],
        categories: row.listing.categories as ListingTerms["categories"], retailPriceCents: Number(row.listing.retailPriceCents),
        linkType: row.listing.linkType as ListingTerms["linkType"], linkValidity: row.listing.linkValidity as ListingTerms["linkValidity"],
        turnaroundDays: row.listing.turnaroundDays, allowsSportsAndGaming: row.listing.allowsSportsAndGaming,
        allowsPharmacy: row.listing.allowsPharmacy, allowsCrypto: row.listing.allowsCrypto,
        allowsForeignLanguage: row.listing.allowsForeignLanguage,
        sponsoredContentMarking: row.listing.sponsoredContentMarking, writingEnabled: row.listing.writingEnabled,
        writingPriceCents: row.listing.writingPriceCents === null ? null : Number(row.listing.writingPriceCents), writingTurnaroundDays: row.listing.writingTurnaroundDays,
        writingFirstDraftCents: row.listing.writingFirstDraftCents === null ? null : Number(row.listing.writingFirstDraftCents), writingFinalDraftCents: row.listing.writingFinalDraftCents === null ? null : Number(row.listing.writingFinalDraftCents),
        buyerRequirements: row.listing.buyerRequirements,
      },
      sourcing: row.source,
    };
  });
}

export async function updateListing(headers: Headers, input: {
  id: string; expectedRevision: number; terms: ListingTerms; commercialSource: CommercialSource;
  supplierId: string | null; fulfillmentSupplierId: string | null; urlVisibleWithoutRecharge: boolean; reason: string;
}) {
  if (!/^[0-9a-f-]{36}$/i.test(input.id) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new Error("Listing version is invalid");
  }
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) {
    throw new Error("A short change reason is required");
  }
  const websiteUrl = normalizeWebsiteUrl(input.terms.websiteUrl);
  if (!websiteUrl) throw new Error("Invalid listing URL");
  const terms = { ...input.terms, websiteUrl };
  const termErrors = validateListingTerms(terms);
  const relationshipErrors = validateListingRelationships(input.commercialSource, input.supplierId, input.fulfillmentSupplierId);
  if (termErrors.length || relationshipErrors.length) throw new Error("Invalid listing fields");

  return staffTransaction(headers, "catalog.manage", async (tx, userId) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('gphkm:catalog-listing:' || ${input.id}, 0))`);
    const [current] = await tx.select().from(listing).where(eq(listing.id, input.id)).for("update").limit(1);
    if (!current || current.revision !== input.expectedRevision || current.status === "ARCHIVED") {
      throw new Error("Listing changed or is unavailable; reload before editing");
    }
    const [source] = await tx.select().from(listingSourcing).where(eq(listingSourcing.listingId, input.id)).for("update").limit(1);
    const [currentUrl] = await tx.select().from(listingUrl).where(eq(listingUrl.listingId, input.id)).for("update").limit(1);
    if (!source || !currentUrl) throw new Error("Listing is incomplete");
    const relationshipIds = [input.supplierId, input.fulfillmentSupplierId].filter((value): value is string => value !== null);
    for (const supplierId of new Set(relationshipIds)) {
      const [found] = await tx.select({ id: supplier.id, status: supplier.status }).from(supplier)
        .where(eq(supplier.id, supplierId)).limit(1);
      const alreadyAssigned = source.supplierId === supplierId || source.fulfillmentSupplierId === supplierId;
      if (!found || (found.status !== "ACTIVE" && !alreadyAssigned)) throw new Error("Selected supplier is unavailable");
    }
    if (current.status === "LIVE") {
      const errors = validatePublishableListing({
        ...terms, id: current.id, revision: current.revision, status: current.status,
        commercialSource: input.commercialSource, supplierId: input.supplierId,
        fulfillmentSupplierId: input.fulfillmentSupplierId, sourceCostCents: null,
        urlVisibleWithoutRecharge: input.urlVisibleWithoutRecharge, metrics: [],
        createdAt: current.createdAt.toISOString(), updatedAt: current.updatedAt.toISOString(),
      });
      if (errors.length) throw new Error("Live listing changes must satisfy publication requirements");
    }

    const nextRevision = current.revision + 1;
    const now = new Date();
    await tx.update(listing).set({
      title: terms.title.trim(), description: terms.description.trim(), countryCode: terms.countryCode,
      primaryLanguage: terms.primaryLanguage, categories: terms.categories, retailPriceCents: String(terms.retailPriceCents),
      linkType: terms.linkType, linkValidity: terms.linkValidity, turnaroundDays: terms.turnaroundDays,
      allowsSportsAndGaming: terms.allowsSportsAndGaming, allowsPharmacy: terms.allowsPharmacy,
      allowsCrypto: terms.allowsCrypto, allowsForeignLanguage: terms.allowsForeignLanguage,
      sponsoredContentMarking: terms.sponsoredContentMarking, writingEnabled: terms.writingEnabled,
      writingPriceCents: terms.writingPriceCents === null ? null : String(terms.writingPriceCents),
      writingTurnaroundDays: terms.writingTurnaroundDays,
      writingFirstDraftCents: terms.writingFirstDraftCents === null ? null : String(terms.writingFirstDraftCents),
      writingFinalDraftCents: terms.writingFinalDraftCents === null ? null : String(terms.writingFinalDraftCents),
      buyerRequirements: terms.buyerRequirements?.trim() || null, revision: nextRevision, updatedAt: now,
    }).where(eq(listing.id, input.id));
    await tx.update(listingUrl).set({ websiteUrl, updatedAt: now }).where(eq(listingUrl.listingId, input.id));
    await tx.update(listingSourcing).set({
      commercialSource: input.commercialSource, supplierId: input.supplierId,
      fulfillmentSupplierId: input.fulfillmentSupplierId,
      urlVisibleWithoutRecharge: input.urlVisibleWithoutRecharge, updatedAt: now,
    }).where(eq(listingSourcing.listingId, input.id));
    await tx.insert(listingRevision).values({ listingId: input.id, revision: nextRevision, terms: { ...terms }, actorUserId: userId, reason });
    await appendAuditEvent(tx, {
      actorUserId: userId, action: "CATALOG_LISTING_UPDATED", targetType: "marketplace_listing", targetId: input.id,
      reasonCode: "LISTING_REVISION_CREATED",
      metadata: { fromRevision: current.revision, toRevision: nextRevision, reason, sourcingChanged: source.commercialSource !== input.commercialSource || source.supplierId !== input.supplierId || source.fulfillmentSupplierId !== input.fulfillmentSupplierId || source.urlVisibleWithoutRecharge !== input.urlVisibleWithoutRecharge },
    });
    return { id: input.id, revision: nextRevision };
  });
}

export async function createSupplier(headers: Headers, input: { name: string; contactName: string; email: string }) {
  const name = input.name.trim();
  const contactName = input.contactName.trim();
  const email = input.email.trim().toLowerCase();
  if (!name || name.length > 160 || !contactName || contactName.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new Error("Enter a supplier name and valid primary contact");
  }
  const id = randomUUID();
  return staffTransaction(headers, "supplier.manage", async (tx, userId) => {
    await tx.insert(supplier).values({ id, name, createdByUserId: userId });
    await tx.insert(supplierContact).values({ id: randomUUID(), supplierId: id, name: contactName, email, isPrimary: true });
    await appendAuditEvent(tx, { actorUserId: userId, action: "SUPPLIER_CREATED", targetType: "supplier", targetId: id });
    return { id };
  });
}

export async function listStaffListings(headers: Headers, requestedPage: unknown = 1) {
  return staffTransaction(headers, "catalog.manage", async (tx) => {
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(listing);
    const pagination = staffCatalogPagination(requestedPage, count?.total ?? 0);
    const rows = await tx.select({
      id: listing.id, title: listing.title, retailPriceCents: listing.retailPriceCents, status: listing.status, revision: listing.revision,
      categories: listing.categories, updatedAt: listing.updatedAt,
      websiteUrl: listingUrl.websiteUrl, commercialSource: listingSourcing.commercialSource,
      supplierId: listingSourcing.supplierId, urlVisibleWithoutRecharge: listingSourcing.urlVisibleWithoutRecharge,
    }).from(listing).leftJoin(listingUrl, eq(listingUrl.listingId, listing.id))
      .leftJoin(listingSourcing, eq(listingSourcing.listingId, listing.id))
      .orderBy(desc(listing.updatedAt), desc(listing.id)).limit(pagination.limit).offset(pagination.offset);
    return { ...pagination, items: rows };
  });
}

export async function listStaffSuppliers(headers: Headers) {
  return staffTransaction(headers, "supplier.manage", async (tx, userId) => {
    const rows = await tx.select({
      id: supplier.id, name: supplier.name, status: supplier.status, contactName: supplierContact.name,
      email: supplierContact.email, updatedAt: supplier.updatedAt,
    }).from(supplier).leftJoin(supplierContact, and(eq(supplierContact.supplierId, supplier.id), eq(supplierContact.isPrimary, true)))
      .orderBy(desc(supplier.updatedAt), desc(supplier.id));
    await appendAuditEvent(tx, { actorUserId: userId, action: "SUPPLIER_CONTACTS_VIEWED", targetType: "supplier_directory", targetId: "directory",
      metadata: { itemCount: rows.filter((row) => row.email !== null).length, result: "ALLOWED" } });
    return rows;
  });
}

export async function listStaffSuppliersPage(
  headers: Headers,
  requested: { page?: unknown; query?: unknown; status?: unknown } = {},
) {
  return staffTransaction(headers, "supplier.manage", async (tx, userId) => {
    const query = typeof requested.query === "string" ? requested.query.trim().slice(0, 120) : "";
    const status = requested.status === "ACTIVE" || requested.status === "INACTIVE" ? requested.status : "";
    const where = and(
      status ? eq(supplier.status, status) : undefined,
      query ? (() => {
        const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
        return or(
          ilike(supplier.name, pattern),
          ilike(supplierContact.name, pattern),
          ilike(supplierContact.email, pattern),
          ilike(supplier.status, pattern),
        );
      })() : undefined,
    );
    const [count] = await tx.select({ total: sql<number>`count(distinct ${supplier.id})::int` })
      .from(supplier)
      .leftJoin(supplierContact, and(eq(supplierContact.supplierId, supplier.id), eq(supplierContact.isPrimary, true)))
      .where(where);
    const pagination = staffCatalogPagination(requested.page ?? 1, count?.total ?? 0);
    const rows = await tx.select({
      id: supplier.id, name: supplier.name, status: supplier.status, contactName: supplierContact.name,
      email: supplierContact.email, updatedAt: supplier.updatedAt,
    }).from(supplier).leftJoin(supplierContact, and(eq(supplierContact.supplierId, supplier.id), eq(supplierContact.isPrimary, true)))
      .where(where)
      .orderBy(desc(supplier.updatedAt), desc(supplier.id)).limit(pagination.limit).offset(pagination.offset);
    await appendAuditEvent(tx, { actorUserId: userId, action: "SUPPLIER_CONTACTS_VIEWED", targetType: "supplier_directory", targetId: "directory",
      metadata: { itemCount: rows.filter((row) => row.email !== null).length, page: pagination.page, totalCount: pagination.total, hasSearch: Boolean(query), statusFilter: status || null, result: "ALLOWED" } });
    return { ...pagination, items: rows, query, status };
  });
}

const normalizeSupplierContact = (input: { name: string; email: string; roleLabel?: string }) => {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const roleLabel = input.roleLabel?.trim() || null;
  if (!name || name.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320 || (roleLabel && roleLabel.length > 120)) {
    throw new Error("Enter valid supplier contact details");
  }
  return { name, email, roleLabel };
};

export async function getStaffSupplierProfile(headers: Headers, id: string, requestedPages: { contacts?: unknown; inventory?: unknown } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return staffTransaction(headers, "supplier.manage", async (tx, userId) => {
    const [record] = await tx.select().from(supplier).where(eq(supplier.id, id)).limit(1);
    if (!record) return null;
    const [contactCount] = await tx.select({ total: sql<number>`count(*)::int` }).from(supplierContact)
      .where(eq(supplierContact.supplierId, id));
    const contactPagination = staffCatalogPagination(requestedPages.contacts, contactCount?.total ?? 0);
    const contacts = await tx.select({ id: supplierContact.id, name: supplierContact.name, email: supplierContact.email,
      roleLabel: supplierContact.roleLabel, isPrimary: supplierContact.isPrimary })
      .from(supplierContact).where(eq(supplierContact.supplierId, id))
      .orderBy(desc(supplierContact.isPrimary), supplierContact.name, supplierContact.id)
      .limit(contactPagination.limit).offset(contactPagination.offset);
    const inventoryWhere = sql`${listingSourcing.supplierId} = ${id} or ${listingSourcing.fulfillmentSupplierId} = ${id}`;
    const [inventoryCount] = await tx.select({ total: sql<number>`count(*)::int` })
      .from(listingSourcing).innerJoin(listing, eq(listingSourcing.listingId, listing.id)).where(inventoryWhere);
    const inventoryPagination = staffCatalogPagination(requestedPages.inventory, inventoryCount?.total ?? 0);
    const inventory = await tx.select({ id: listing.id, title: listing.title, status: listing.status, categories: listing.categories,
      retailPriceCents: listing.retailPriceCents, countryCode: listing.countryCode, primaryLanguage: listing.primaryLanguage,
      commercialSource: listingSourcing.commercialSource, websiteUrl: listingUrl.websiteUrl })
      .from(listingSourcing).innerJoin(listing, eq(listing.id, listingSourcing.listingId))
      .leftJoin(listingUrl, eq(listingUrl.listingId, listing.id))
      .where(inventoryWhere).orderBy(listing.title, listing.id)
      .limit(inventoryPagination.limit).offset(inventoryPagination.offset);
    const performanceResult = await tx.execute(sql`select * from public.gphkm_supplier_operational_summary(${id}, ${new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)})`);
    const performanceRows = (performanceResult as unknown as { rows?: Array<Record<string, string | number | null>> }).rows ?? [];
    const performance: Record<string, string | number | null> = performanceRows[0] ?? { paid_placements: 0, completed: 0, rejected: 0, canceled: 0,
      median_publication_hours: null, on_time_count: 0, on_time_sample_size: 0 };
    const refundedResult = await tx.execute(sql`select public.gphkm_supplier_operational_refunded_count(${id}, ${new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)}) as refunded`);
    const refundedRows = (refundedResult as unknown as { rows?: Array<{ refunded: string | number }> }).rows ?? [];
    const refunded = refundedRows[0]?.refunded ?? 0;
    await appendAuditEvent(tx, { actorUserId: userId, action: "SUPPLIER_CONTACTS_VIEWED", targetType: "supplier", targetId: id,
      metadata: { contactCount: contacts.length, contactPage: contactPagination.page, inventoryCount: inventory.length,
        inventoryPage: inventoryPagination.page, result: "ALLOWED" } });
    return { supplier: record, contacts, contactPagination, inventory, inventoryPagination,
      performance: { ...performance, refunded } as Record<string, string | number | null> & { refunded: string | number } };
  });
}

export async function updateSupplierProfile(headers: Headers, input: {
  id: string; name: string; notes: string; status: "ACTIVE" | "INACTIVE";
}) {
  if (!/^[0-9a-f-]{36}$/i.test(input.id)) throw new Error("Supplier unavailable");
  const name = input.name.trim();
  const notes = input.notes.trim();
  if (!name || name.length > 160 || notes.length > 4000 || !["ACTIVE", "INACTIVE"].includes(input.status)) {
    throw new Error("Invalid supplier details");
  }
  return staffTransaction(headers, "supplier.manage", async (tx, userId) => {
    const [current] = await tx.select({ id: supplier.id, name: supplier.name, notes: supplier.notes, status: supplier.status })
      .from(supplier).where(eq(supplier.id, input.id)).for("update").limit(1);
    if (!current) throw new Error("Supplier unavailable");
    await tx.update(supplier).set({ name, notes: notes || null, status: input.status, updatedAt: new Date() }).where(eq(supplier.id, input.id));
    await appendAuditEvent(tx, { actorUserId: userId, action: "SUPPLIER_PROFILE_UPDATED", targetType: "supplier", targetId: input.id,
      metadata: { fromState: current.status, toState: input.status } });
  });
}

export async function saveSupplierContact(headers: Headers, input: {
  supplierId: string; contactId?: string; name: string; email: string; roleLabel?: string; isPrimary: boolean;
}) {
  if (!/^[0-9a-f-]{36}$/i.test(input.supplierId) || (input.contactId && !/^[0-9a-f-]{36}$/i.test(input.contactId))) {
    throw new Error("Supplier contact unavailable");
  }
  const contact = normalizeSupplierContact(input);
  return staffTransaction(headers, "supplier.manage", async (tx, userId) => {
    const [parent] = await tx.select({ id: supplier.id }).from(supplier).where(eq(supplier.id, input.supplierId)).for("update").limit(1);
    if (!parent) throw new Error("Supplier unavailable");
    const currentContacts = await tx.select({ id: supplierContact.id, isPrimary: supplierContact.isPrimary })
      .from(supplierContact).where(eq(supplierContact.supplierId, input.supplierId)).for("update");
    const existingContact = input.contactId ? currentContacts.find((row) => row.id === input.contactId) : undefined;
    if (input.contactId && !existingContact) throw new Error("Supplier contact unavailable");
    if (!input.isPrimary && (existingContact?.isPrimary || !currentContacts.some((row) => row.isPrimary))) {
      throw new Error("A supplier must retain a primary contact");
    }
    if (input.isPrimary) await tx.update(supplierContact).set({ isPrimary: false, updatedAt: new Date() })
      .where(eq(supplierContact.supplierId, input.supplierId));
    if (input.contactId) {
      await tx.update(supplierContact).set({ ...contact, isPrimary: input.isPrimary, updatedAt: new Date() })
        .where(eq(supplierContact.id, input.contactId));
    } else {
      await tx.insert(supplierContact).values({ id: randomUUID(), supplierId: input.supplierId, ...contact, isPrimary: input.isPrimary });
    }
    await appendAuditEvent(tx, { actorUserId: userId, action: input.contactId ? "SUPPLIER_CONTACT_UPDATED" : "SUPPLIER_CONTACT_CREATED",
      targetType: "supplier", targetId: input.supplierId, metadata: { result: input.isPrimary ? "PRIMARY_CONTACT" : "CONTACT_SAVED" } });
  });
}
