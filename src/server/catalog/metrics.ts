import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { listing, listingMetricApprovalEvent, listingMetricObservation, listingUrl } from "@/db/catalog-schema";
import { auditEvent } from "@/db/schema";
import { appendAuditEvent } from "@/server/audit/append";
import { requireStaffAccess } from "@/server/auth/staff";
import { fetchOpenPageRank, isMetricDomainRefreshable, normalizeMetricDomain } from "@/server/metrics/open-page-rank";
import { validateMetricRedistributionDecision, type MetricRedistributionDecision } from "@/modules/catalog/metric-approval";
import { staffCatalogPagination } from "@/modules/catalog/pagination";

const MAX_LISTINGS_PER_BATCH = 100;
const MAX_BATCHES_PER_STAFF_DAY = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export class MetricRefreshError extends Error {
  constructor(readonly code: "DAILY_LIMIT" | "NON_PUBLIC_DOMAIN") {
    super(code);
  }
}

export async function listMetricRefreshCandidates(headers: Headers, requestedPage: unknown = 1) {
  const actor = await requireStaffAccess(headers, "metrics.refresh");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(listing)
      .innerJoin(listingUrl, eq(listingUrl.listingId, listing.id));
    const pagination = staffCatalogPagination(requestedPage, count?.total ?? 0);
    const rows = await tx.select({
      id: listing.id, title: listing.title, status: listing.status, websiteUrl: listingUrl.websiteUrl,
    }).from(listing).innerJoin(listingUrl, eq(listingUrl.listingId, listing.id))
      .orderBy(desc(listing.updatedAt), desc(listing.id)).limit(pagination.limit).offset(pagination.offset);
    const ids = rows.map((row) => row.id);
    const history = ids.length ? await tx.select({
      listingId: listingMetricObservation.listingId, value: listingMetricObservation.value,
      metricScope: listingMetricObservation.metricScope,
      metricTarget: listingMetricObservation.metricTarget, requestedTarget: listingMetricObservation.requestedTarget,
      status: listingMetricObservation.status, observedOn: listingMetricObservation.observedOn,
      refreshedAt: listingMetricObservation.refreshedAt,
    }).from(listingMetricObservation).where(and(
      inArray(listingMetricObservation.listingId, ids),
      eq(listingMetricObservation.provider, "OPEN_PAGE_RANK"),
    )).orderBy(desc(listingMetricObservation.refreshedAt)) : [];
    const latest = new Map<string, typeof history[number]>();
    for (const observation of history) if (!latest.has(observation.listingId)) latest.set(observation.listingId, observation);
    return { ...pagination, items: rows.map((row) => {
      const metric = latest.get(row.id) ?? null;
      if (!metric || metric.requestedTarget === normalizeMetricDomain(new URL(row.websiteUrl).hostname)) return { ...row, metric };
      return { ...row, metric: { ...metric, value: null, status: "STALE" as const } };
    }), canApprove: actor.role === "SUPER_ADMIN" };
  });
}

export async function refreshOpenPageRank(headers: Headers, listingIds: readonly string[]) {
  const actor = await requireStaffAccess(headers, "metrics.refresh");
  if (!Array.isArray(listingIds) || listingIds.length < 1 || listingIds.length > MAX_LISTINGS_PER_BATCH ||
      listingIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) ||
      new Set(listingIds).size !== listingIds.length) {
    throw new Error("Select 1 to 100 unique listings");
  }

  const requestId = randomUUID();
  const batch = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`opr-refresh:${actor.userId}`}, 0))`);
    const since = new Date(Date.now() - WINDOW_MS);
    const [prior] = await tx.select({ count: sql<number>`count(*)::int` }).from(auditEvent).where(and(
      eq(auditEvent.actorUserId, actor.userId),
      eq(auditEvent.action, "METRICS_REFRESH_STARTED"),
      gte(auditEvent.createdAt, since),
    ));
    if ((prior?.count ?? 0) >= MAX_BATCHES_PER_STAFF_DAY) throw new MetricRefreshError("DAILY_LIMIT");
    const rows = await tx.select({ id: listing.id, websiteUrl: listingUrl.websiteUrl })
      .from(listing).innerJoin(listingUrl, eq(listingUrl.listingId, listing.id))
      .where(inArray(listing.id, [...listingIds]));
    if (rows.length !== listingIds.length) throw new Error("One or more listings are unavailable");
    const domains = rows.map(({ websiteUrl }) => normalizeMetricDomain(new URL(websiteUrl).hostname));
    if (domains.some((domain) => !isMetricDomainRefreshable(domain))) throw new MetricRefreshError("NON_PUBLIC_DOMAIN");
    await appendAuditEvent(tx, {
      actorUserId: actor.userId, action: "METRICS_REFRESH_STARTED", targetType: "listing_metric_batch", targetId: requestId,
      correlationId: requestId, metadata: { provider: "OPEN_PAGE_RANK", itemCount: rows.length },
    });
    return { rows, domains };
  });

  try {
    const providerRows = await fetchOpenPageRank(batch.domains);
    const refreshedAt = new Date();
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
      const observations = batch.rows.map(({ id, websiteUrl }) => {
        const providerRow = providerRows.find((row) => row.requestedTarget === normalizeMetricDomain(new URL(websiteUrl).hostname));
        if (!providerRow) throw new Error("Provider omitted a requested domain");
        return {
          id: randomUUID(), listingId: id, provider: "OPEN_PAGE_RANK" as const, metricScope: providerRow.scope,
          metricTarget: providerRow.normalizedTarget, requestedTarget: providerRow.requestedTarget,
          value: providerRow.value === null ? null : String(providerRow.value), status: providerRow.status === "available" ? "AVAILABLE" as const : "MISSING" as const,
          observedOn: new Date(`${providerRow.observedOn}T00:00:00.000Z`), refreshedAt,
          source: providerRow.source, redistributionApproved: false, attributionText: null, requestId,
        };
      });
      await tx.insert(listingMetricObservation).values(observations);
      await appendAuditEvent(tx, {
        actorUserId: actor.userId, action: "METRICS_REFRESH_COMPLETED", targetType: "listing_metric_batch", targetId: requestId,
        correlationId: requestId, metadata: { provider: "OPEN_PAGE_RANK", itemCount: observations.length },
      });
    });
    return { requestId, refreshed: batch.rows.length };
  } catch {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
      await appendAuditEvent(tx, {
        actorUserId: actor.userId, action: "METRICS_REFRESH_FAILED", targetType: "listing_metric_batch", targetId: requestId,
        correlationId: requestId, reasonCode: "PROVIDER_OR_PERSISTENCE_FAILED", metadata: { provider: "OPEN_PAGE_RANK", itemCount: batch.rows.length },
      });
    });
    throw new Error("Metric refresh failed. The attempt was recorded for review.");
  }
}

export async function listMetricRedistributionCandidates(headers: Headers, requestedPage = 1) {
  const actor = await requireStaffAccess(headers, "metrics.approve");
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 10_000) : 1;
  const pageSize = 50;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const loadPage = (targetPage: number) => tx.execute(sql`
      SELECT current_metric.id AS "observationId", current_metric.listing_id AS "listingId",
        l.title, u.website_url AS "websiteUrl", current_metric.provider::text AS provider,
        current_metric.metric_scope AS "metricScope",
        current_metric.metric_target AS "metricTarget", current_metric.requested_target AS "requestedTarget",
        current_metric.status, current_metric.value::text AS value,
        current_metric.observed_on AS "observedOn", current_metric.refreshed_at AS "refreshedAt",
        latest.decision, latest.attribution_text AS "attributionText",
        latest.evidence_reference AS "evidenceReference", latest.reason AS "reviewReason",
        count(*) OVER()::int AS total
      FROM (
        SELECT DISTINCT ON (m.listing_id, m.provider, m.metric_scope) m.*
        FROM public.listing_metric_observation m
        ORDER BY m.listing_id, m.provider, m.metric_scope, m.refreshed_at DESC, m.id DESC
      ) current_metric
      JOIN public.marketplace_listing l ON l.id = current_metric.listing_id
      JOIN public.marketplace_listing_url u ON u.listing_id = l.id
      LEFT JOIN LATERAL (
        SELECT e.decision, e.attribution_text, e.evidence_reference, e.reason
        FROM public.listing_metric_approval_event e WHERE e.observation_id = current_metric.id
        ORDER BY e.event_sequence DESC LIMIT 1
      ) latest ON true
      WHERE current_metric.metric_target IS NOT NULL AND current_metric.requested_target IS NOT NULL
        AND current_metric.requested_target = lower(rtrim(regexp_replace(u.website_url, '^https://', ''), '/'))
      ORDER BY current_metric.refreshed_at DESC, current_metric.id DESC
      LIMIT ${pageSize} OFFSET ${(targetPage - 1) * pageSize}
    `);
    let result = await loadPage(page);
    let rows = result.rows as Array<{
      observationId: string; listingId: string; title: string; websiteUrl: string;
      provider: string; metricScope: string; metricTarget: string | null; requestedTarget: string | null;
      status: string; value: string | null; observedOn: Date | null;
      refreshedAt: Date; decision: string | null; attributionText: string | null;
      evidenceReference: string | null; reviewReason: string | null; total: number;
    }>;
    let total = rows[0]?.total ?? 0;
    let currentPage = page;
    if (rows.length === 0 && currentPage > 1) {
      const countResult = await tx.execute(sql`
          SELECT count(*)::int AS total
          FROM (
            SELECT DISTINCT ON (m.listing_id, m.provider, m.metric_scope) m.listing_id, m.provider, m.metric_scope
              FROM public.listing_metric_observation m
              JOIN public.marketplace_listing_url u ON u.listing_id = m.listing_id
             WHERE m.metric_target IS NOT NULL AND m.requested_target IS NOT NULL
               AND m.requested_target = lower(rtrim(regexp_replace(u.website_url, '^https://', ''), '/'))
             ORDER BY m.listing_id, m.provider, m.metric_scope, m.refreshed_at DESC, m.id DESC
          ) current_metric
      `);
      total = Number((countResult.rows[0] as { total?: number } | undefined)?.total ?? 0);
      currentPage = Math.max(1, Math.ceil(total / pageSize));
      result = await loadPage(currentPage);
      rows = result.rows as typeof rows;
    }
    return { items: rows, page: currentPage, pageCount: Math.max(1, Math.ceil(total / pageSize)), total };
  });
}

export async function setMetricRedistributionApproval(headers: Headers, input: {
  observationId: string;
  decision: MetricRedistributionDecision;
  attributionText?: string;
  evidenceReference: string;
  reason: string;
}) {
  const actor = await requireStaffAccess(headers, "metrics.approve");
  if (!/^[0-9a-f-]{36}$/i.test(input.observationId)) throw new Error("Invalid observation");
  const decision = validateMetricRedistributionDecision(input);
  const eventId = randomUUID();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`metric-approval:${input.observationId}`}, 0))`);
    const [observation] = await tx.select({
      id: listingMetricObservation.id, listingId: listingMetricObservation.listingId,
      provider: listingMetricObservation.provider, metricScope: listingMetricObservation.metricScope,
      metricTarget: listingMetricObservation.metricTarget, requestedTarget: listingMetricObservation.requestedTarget,
      status: listingMetricObservation.status, value: listingMetricObservation.value,
    }).from(listingMetricObservation).where(eq(listingMetricObservation.id, input.observationId)).limit(1);
    if (!observation) throw new Error("Metric observation is unavailable");
    const [url] = await tx.select({ websiteUrl: listingUrl.websiteUrl }).from(listingUrl)
      .where(eq(listingUrl.listingId, observation.listingId)).limit(1);
    if (!url || !observation.metricTarget || observation.requestedTarget !== normalizeMetricDomain(new URL(url.websiteUrl).hostname)) {
      throw new Error("Metric observation is no longer for the current listing URL; refresh it before review");
    }
    const [latest] = await tx.select({ id: listingMetricObservation.id }).from(listingMetricObservation)
      .where(and(eq(listingMetricObservation.listingId, observation.listingId),
        eq(listingMetricObservation.provider, observation.provider),
        eq(listingMetricObservation.metricScope, observation.metricScope)))
      .orderBy(desc(listingMetricObservation.refreshedAt), desc(listingMetricObservation.id)).limit(1);
    if (latest?.id !== observation.id) throw new Error("Metric observation is no longer current; review the latest refresh");
    if (decision.decision === "APPROVED" && (observation.status !== "AVAILABLE" || observation.value === null)) {
      throw new Error("Only an available metric observation can be approved");
    }
    const [prior] = await tx.select({ decision: listingMetricApprovalEvent.decision })
      .from(listingMetricApprovalEvent).where(eq(listingMetricApprovalEvent.observationId, observation.id))
      .orderBy(desc(listingMetricApprovalEvent.eventSequence)).limit(1);
    if (decision.decision === "REVOKED" && prior?.decision !== "APPROVED") {
      throw new Error("Only a currently approved observation can be revoked");
    }
    await appendAuditEvent(tx, {
      actorUserId: actor.userId,
      action: decision.decision === "APPROVED" ? "METRIC_REDISTRIBUTION_APPROVED" : "METRIC_REDISTRIBUTION_REVOKED",
      targetType: "listing_metric_observation", targetId: observation.id, correlationId: eventId,
      reasonCode: "INTERNAL_RIGHTS_REVIEW_ATTESTATION",
      metadata: { listingId: observation.listingId, provider: observation.provider, decision: decision.decision },
    });
    await tx.insert(listingMetricApprovalEvent).values({
      id: eventId, observationId: observation.id, listingId: observation.listingId,
      provider: observation.provider, decision: decision.decision,
      attributionText: decision.attributionText, evidenceReference: decision.evidenceReference,
      reason: decision.reason, actorUserId: actor.userId,
    });
    return { eventId, decision: decision.decision };
  });
}
