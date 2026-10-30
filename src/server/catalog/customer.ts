import "server-only";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { listing, listingUrl } from "@/db/catalog-schema";
import { organization } from "@/db/schema";
import { containsWebsiteAddress, validateListingTerms, type CustomerListing, type ListingMetric, type ListingTerms } from "@/modules/catalog/domain";
import { LISTING_LANGUAGES } from "@/modules/catalog/taxonomy";
import { isMarketplaceTrialActive } from "@/modules/wallet/marketplace-trial";
import { requireVerifiedCustomer, withOrganizationContext } from "@/server/identity/customer-context";

export async function listCustomerListings(
  headers: Headers,
  organizationId: string,
  filters: { search?: string; category?: string; country?: string; language?: string; doFollowOnly?: boolean; page?: number } = {},
): Promise<{ accessAllowed: boolean; listings: CustomerListing[]; pagination: { page: number; pageCount: number; total: number } }> {
  const search = filters.search?.trim().slice(0, 100) ?? "";
  const category = filters.category?.trim() ?? "";
  const country = filters.country?.trim().toUpperCase() ?? "";
  const language = filters.language?.trim() ?? "";
  const page = Number.isSafeInteger(filters.page) && (filters.page ?? 0) > 0 ? Math.min(filters.page!, 10_000) : 1;
  const actor = await requireVerifiedCustomer(headers);
  return withOrganizationContext(headers, organizationId, async (tx) => {
    await tx.execute(sql`select set_config('app.metric_customer_display_l05_verified', ${process.env.GPHKM_METRIC_CUSTOMER_DISPLAY_L05_VERIFIED === "true" ? "true" : "false"}, true)`);
    const [org] = await tx.select({ createdAt: organization.createdAt }).from(organization)
      .where(eq(organization.id, organizationId)).limit(1);
    if (!org) throw new Error("Organization unavailable");
    const now = new Date();
    const trialActive = isMarketplaceTrialActive(org.createdAt, now);
    const { rows: accessRows } = await tx.execute(sql`select public.gphkm_customer_has_marketplace_access(${organizationId}) as active`);
    const hasPaidAccess = (accessRows[0] as { active: boolean } | undefined)?.active === true;
    if (!trialActive && !hasPaidAccess) return { accessAllowed: false, listings: [], pagination: { page: 1, pageCount: 1, total: 0 } };

    const conditions = [eq(listing.status, "LIVE")];
    if (category) conditions.push(sql`${category} = ANY(${listing.categories})`);
    if (country) conditions.push(/^[A-Z]{2}$/.test(country) ? eq(listing.countryCode, country) : sql`false`);
    if (language) conditions.push((LISTING_LANGUAGES as readonly string[]).includes(language) ? eq(listing.primaryLanguage, language) : sql`false`);
    if (filters.doFollowOnly) conditions.push(eq(listing.linkType, "DOFOLLOW"));
    if (search) conditions.push(or(ilike(listing.title, `%${search}%`), ilike(listing.description, `%${search}%`))!);
    const [countRow] = await tx.select({ total: sql<string>`count(*)::text` }).from(listing).where(and(...conditions));
    const total = Number(countRow?.total ?? 0);
    const pageCount = Math.max(1, Math.ceil(total / 100));
    const currentPage = Math.min(page, pageCount);
    const rows = await tx.select({
      id: listing.id, title: listing.title, description: listing.description, countryCode: listing.countryCode,
      primaryLanguage: listing.primaryLanguage, categories: listing.categories, retailPriceCents: listing.retailPriceCents,
      linkType: listing.linkType, linkValidity: listing.linkValidity, turnaroundDays: listing.turnaroundDays,
      allowsSportsAndGaming: listing.allowsSportsAndGaming, allowsPharmacy: listing.allowsPharmacy,
      allowsCrypto: listing.allowsCrypto, allowsForeignLanguage: listing.allowsForeignLanguage,
      sponsoredContentMarking: listing.sponsoredContentMarking, writingEnabled: listing.writingEnabled,
      writingPriceCents: listing.writingPriceCents, writingTurnaroundDays: listing.writingTurnaroundDays,
      writingFirstDraftCents: listing.writingFirstDraftCents, writingFinalDraftCents: listing.writingFinalDraftCents,
      buyerRequirements: listing.buyerRequirements, revision: listing.revision, websiteUrl: listingUrl.websiteUrl,
    }).from(listing).leftJoin(listingUrl, and(eq(listingUrl.listingId, listing.id),
      sql`public.gphkm_customer_can_read_listing_url(${listing.id}, ${organizationId}, ${actor.userId})`))
      .where(and(...conditions)).orderBy(asc(listing.retailPriceCents), asc(listing.id)).limit(100).offset((currentPage - 1) * 100);
    const ids = rows.map((row) => row.id);
    const metricIds = sql`array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::text[]`;
    const metricResult = ids.length ? await tx.execute(sql`select * from public.gphkm_latest_customer_listing_metrics(
      ${metricIds}, ${actor.userId}, ${organizationId})`) : { rows: [] };
    const metrics = metricResult.rows as Array<{
      listing_id: string; provider: string; metric_scope: string; value: string | number | null;
      observed_on: Date | null; source: string; attribution_text: string;
    }>;
    const metricsByListing = new Map<string, typeof metrics>();
    for (const metric of metrics) metricsByListing.set(metric.listing_id, [...(metricsByListing.get(metric.listing_id) ?? []), metric]);

    const projected: CustomerListing[] = [];
    for (const row of rows) {
      const buyerCopy = `${row.title}\n${row.description}\n${row.buyerRequirements ?? ""}`;
      if (!row.websiteUrl && containsWebsiteAddress(buyerCopy)) continue;
      const terms: ListingTerms = {
        title: row.title, description: row.description, websiteUrl: row.websiteUrl ?? "https://hidden.invalid/",
        countryCode: row.countryCode, primaryLanguage: row.primaryLanguage as ListingTerms["primaryLanguage"],
        categories: row.categories as ListingTerms["categories"], retailPriceCents: Number(row.retailPriceCents),
        linkType: row.linkType as ListingTerms["linkType"], linkValidity: row.linkValidity as ListingTerms["linkValidity"],
        turnaroundDays: row.turnaroundDays, allowsSportsAndGaming: row.allowsSportsAndGaming,
        allowsPharmacy: row.allowsPharmacy, allowsCrypto: row.allowsCrypto, allowsForeignLanguage: row.allowsForeignLanguage,
        sponsoredContentMarking: row.sponsoredContentMarking, writingEnabled: row.writingEnabled,
        writingPriceCents: row.writingPriceCents === null ? null : Number(row.writingPriceCents),
        writingTurnaroundDays: row.writingTurnaroundDays,
        writingFirstDraftCents: row.writingFirstDraftCents === null ? null : Number(row.writingFirstDraftCents),
        writingFinalDraftCents: row.writingFinalDraftCents === null ? null : Number(row.writingFinalDraftCents),
        buyerRequirements: row.buyerRequirements,
      };
      if (validateListingTerms(terms).length || [row.allowsSportsAndGaming, row.allowsPharmacy, row.allowsCrypto, row.allowsForeignLanguage].some((value) => value === null)) continue;
      projected.push({
        id: row.id, revision: row.revision, title: row.title, description: row.description, countryCode: row.countryCode,
        primaryLanguage: terms.primaryLanguage, categories: terms.categories, retailPriceCents: terms.retailPriceCents,
        linkType: terms.linkType, linkValidity: terms.linkValidity, turnaroundDays: row.turnaroundDays,
        allowsSportsAndGaming: row.allowsSportsAndGaming === true, allowsPharmacy: row.allowsPharmacy === true,
        allowsCrypto: row.allowsCrypto === true, allowsForeignLanguage: row.allowsForeignLanguage === true,
        sponsoredContentMarking: row.sponsoredContentMarking, writingEnabled: row.writingEnabled,
        writingPriceCents: terms.writingPriceCents, writingTurnaroundDays: row.writingTurnaroundDays,
        writingFirstDraftCents: terms.writingFirstDraftCents, writingFinalDraftCents: terms.writingFinalDraftCents,
        buyerRequirements: row.buyerRequirements,
        ...(row.websiteUrl ? { websiteUrl: row.websiteUrl } : {}),
        metrics: (metricsByListing.get(row.id) ?? []).map((metric) => ({
          provider: metric.provider as ListingMetric["provider"], metricScope: metric.metric_scope as ListingMetric["metricScope"],
          value: metric.value === null ? null : Number(metric.value),
          status: "AVAILABLE" as const, observedOn: metric.observed_on?.toISOString() ?? null,
          source: metric.source, attributionText: metric.attribution_text,
        })),
      });
    }
    return { accessAllowed: true, listings: projected, pagination: { page: currentPage, pageCount, total } };
  });
}
