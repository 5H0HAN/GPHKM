import "server-only";
import { and, count, eq, sql } from "drizzle-orm";
import { customerCartItem } from "@/db/cart-schema";
import { listing } from "@/db/catalog-schema";
import { MAX_ORDER_ITEMS } from "@/modules/orders/checkout";
import { validateCustomerCartDraft, type CustomerCartVersion } from "@/modules/orders/cart";
import { withOrganizationContext, withProtectedOrganizationContext } from "@/server/identity/customer-context";
import { listCustomerListings } from "@/server/catalog/customer";
import type { DbTransaction } from "@/server/audit/append";

export class CustomerCartConflict extends Error {
  constructor(message = "The shared cart changed. Refresh it before continuing.") {
    super(message);
  }
}

const isCartGenerationId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

async function lockCustomerCart(tx: DbTransaction, organizationId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('gphkm:customer-cart:' || ${organizationId}, 0))`);
}

export async function getCustomerCartCount(headers: Headers, organizationId: string) {
  return withOrganizationContext(headers, organizationId, async (tx) => {
    const [row] = await tx.select({ count: count() }).from(customerCartItem);
    return row?.count ?? 0;
  });
}

export async function getCustomerCart(headers: Headers, organizationId: string) {
  const rows = await withOrganizationContext(headers, organizationId, async (tx) =>
    tx.select({
      listingId: customerCartItem.listingId,
      listingRevision: customerCartItem.listingRevision,
      generationId: customerCartItem.generationId,
      version: customerCartItem.version,
      draft: customerCartItem.draft,
    }).from(customerCartItem).orderBy(customerCartItem.updatedAt, customerCartItem.listingId),
  );
  const catalog = rows.length
    ? await listCustomerListings(headers, organizationId, { listingIds: rows.map((row) => row.listingId) })
    : { accessAllowed: true, listings: [], pagination: { page: 1, pageCount: 1, total: 0 } };
  const listings = new Map(catalog.listings.map((item) => [item.id, item]));
  return {
    accessAllowed: catalog.accessAllowed,
    items: rows.map((item) => ({
      ...item,
      draft: validateCustomerCartDraft(item.draft),
      listing: listings.get(item.listingId) ?? null,
    })),
  };
}

export async function saveCustomerCartItem(headers: Headers, organizationId: string, input: {
  listingId: string;
  listingRevision: number;
  version: number;
  generationId: string | null;
  draft: unknown;
}) {
  const draft = validateCustomerCartDraft(input.draft);
  if (!input.listingId || input.listingId.length > 128 ||
      !Number.isSafeInteger(input.listingRevision) || input.listingRevision < 1 ||
      !Number.isSafeInteger(input.version) || input.version < 0 ||
      (input.generationId !== null && !isCartGenerationId(input.generationId)) ||
      (input.version === 0 && input.generationId !== null) || (input.version > 0 && !input.generationId)) {
    throw new Error("Invalid cart details");
  }
  return withProtectedOrganizationContext(headers, organizationId, async (tx) => {
    await lockCustomerCart(tx, organizationId);
    const [offer] = await tx.select({ revision: listing.revision, status: listing.status })
      .from(listing).where(eq(listing.id, input.listingId)).limit(1);
    if (!offer || offer.status !== "LIVE") throw new Error("Cart listing is unavailable");
    const [existing] = await tx.select().from(customerCartItem).where(and(
      eq(customerCartItem.organizationId, organizationId),
      eq(customerCartItem.listingId, input.listingId),
    )).limit(1);
    if (existing && (existing.version !== input.version || existing.generationId !== input.generationId)) {
      throw new CustomerCartConflict();
    }
    if (!existing && (input.version !== 0 || input.generationId !== null)) throw new CustomerCartConflict();
    if (input.listingRevision > offer.revision || (!existing && input.listingRevision !== offer.revision)) {
      throw new Error("Cart listing changed. Review the current listing before saving it.");
    }
    if (!existing) {
      const [cartCount] = await tx.select({ count: count() }).from(customerCartItem);
      if ((cartCount?.count ?? 0) >= MAX_ORDER_ITEMS) throw new Error("The shared cart can contain up to 25 placements.");
      const [created] = await tx.insert(customerCartItem).values({
        organizationId,
        listingId: input.listingId,
        listingRevision: input.listingRevision,
        draft,
      }).returning({ version: customerCartItem.version, generationId: customerCartItem.generationId });
      if (!created) throw new Error("The shared cart could not be saved.");
      return created;
    }

    const [updated] = await tx.update(customerCartItem).set({
      listingRevision: input.listingRevision,
      draft,
      version: existing.version + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(customerCartItem.organizationId, organizationId),
      eq(customerCartItem.listingId, input.listingId),
      eq(customerCartItem.version, input.version),
      eq(customerCartItem.generationId, existing.generationId),
    )).returning({ version: customerCartItem.version, generationId: customerCartItem.generationId });
    if (!updated) throw new CustomerCartConflict();
    return updated;
  });
}

export async function removeCustomerCartItem(headers: Headers, organizationId: string, listingId: string, expected: {
  version: number;
  generationId: string | null;
}) {
  if (!listingId || listingId.length > 128 || !Number.isSafeInteger(expected.version) || expected.version < 0 ||
      (expected.version === 0 && expected.generationId !== null) ||
      (expected.version > 0 && !isCartGenerationId(expected.generationId))) {
    throw new Error("Invalid cart details");
  }
  return withProtectedOrganizationContext(headers, organizationId, async (tx) => {
    await lockCustomerCart(tx, organizationId);
    const scope = [
      eq(customerCartItem.organizationId, organizationId),
      eq(customerCartItem.listingId, listingId),
    ];
    const [existing] = await tx.select({ version: customerCartItem.version, generationId: customerCartItem.generationId })
      .from(customerCartItem).where(and(...scope)).limit(1);
    if (!existing) {
      if (expected.version === 0 && expected.generationId === null) return 0;
      return 0;
    }
    if (existing.version !== expected.version || existing.generationId !== expected.generationId) throw new CustomerCartConflict();
    const deleted = await tx.delete(customerCartItem).where(and(
      ...scope,
      eq(customerCartItem.version, expected.version),
      eq(customerCartItem.generationId, existing.generationId),
    ));
    return deleted.rowCount ?? 0;
  });
}

export async function clearCustomerCart(headers: Headers, organizationId: string) {
  return withProtectedOrganizationContext(headers, organizationId, async (tx) => {
    await lockCustomerCart(tx, organizationId);
    const deleted = await tx.delete(customerCartItem).where(eq(customerCartItem.organizationId, organizationId));
    return deleted.rowCount ?? 0;
  });
}

export async function clearCheckedOutCustomerCartItems(
  tx: DbTransaction,
  organizationId: string,
  listingIds: string[],
  versions: Record<string, CustomerCartVersion>,
) {
  await lockCustomerCart(tx, organizationId);
  for (const listingId of listingIds) {
    const token = versions[listingId];
    if (!token || !Number.isSafeInteger(token.version) || token.version < 1 || !token.generationId) {
      throw new Error("Cart has changed. Refresh the shared cart before placing the order.");
    }
    const deleted = await tx.delete(customerCartItem).where(and(
      eq(customerCartItem.organizationId, organizationId),
      eq(customerCartItem.listingId, listingId),
      eq(customerCartItem.version, token.version),
      eq(customerCartItem.generationId, token.generationId),
    ));
    if (deleted.rowCount !== 1) throw new CustomerCartConflict("Cart has changed. Refresh the shared cart before placing the order.");
  }
}
