export type PacketContent = Readonly<{
  version: number;
  targetUrl: string;
  anchorText: string;
  articleText: string | null;
  instructions: string | null;
  supplierId: string | null;
  recipientEmail: string;
  contentHash: string;
  noticeVersion: string | null;
  consentedAt: Date | string;
  listingTerms?: unknown;
}>;

export type PacketContentResolution = { content: PacketContent | null; error?: Error };
export type PacketContentVersionRow = Readonly<{
  id: string;
  itemId: string;
  requestId: string;
  version: number;
  targetUrl: string;
  anchorText: string;
  articleText: string | null;
  instructions: string | null;
  supplierId: string | null;
  recipientEmail: string;
  contentHash: string;
}>;
export type PacketContentEventRow = {
  requestId: string;
  eventType: string;
  versionId: string | null;
  contentHash: string | null;
  noticeVersion: string | null;
  createdAt: Date | string;
};

// Pure projection used by the batched packet resolver. Database reads supply
// only each request's latest event and at most 50 versions per item.
export function resolvePacketContentRows(input: {
  itemIds: string[];
  latestRequests: Array<{ itemId: string; requestId: string }>;
  routes: Array<{ itemId: string; supplierId: string | null; recipientEmail: string | null }>;
  versions: PacketContentVersionRow[];
  latestEvents: PacketContentEventRow[];
  declinedRequestIds: string[];
  acceptedTerms: Array<{ requestId: string; contentHash: string | null; terms: unknown }>;
}): Map<string, PacketContentResolution> {
  const results = new Map(input.itemIds.map((id) => [id, { content: null } as PacketContentResolution]));
  const latestEventByRequest = new Map(input.latestEvents.map((event) => [event.requestId, event]));
  const routeByItem = new Map(input.routes.map((route) => [route.itemId, route]));
  const requestByItem = new Map(input.latestRequests.map((request) => [request.itemId, request.requestId]));
  const declined = new Set(input.declinedRequestIds);
  const termsByConsent = new Map(input.acceptedTerms.filter((row) => row.contentHash !== null)
    .map((row) => [`${row.requestId}\0${row.contentHash}`, row.terms]));

  for (const [itemId, requestId] of requestByItem) {
    const event = latestEventByRequest.get(requestId);
    if ((event?.eventType === "REQUESTED" || event?.eventType === "APPROVED") && !declined.has(requestId)) {
      results.set(itemId, { content: null, error: new Error("Supplier packet is blocked until the latest customer content change is resolved") });
    }
  }

  const chosen = new Map<string, { version: PacketContentVersionRow; consent: PacketContentEventRow }>();
  for (const version of input.versions) {
    const event = latestEventByRequest.get(version.requestId);
    const route = routeByItem.get(version.itemId);
    if (!chosen.has(version.itemId) && !results.get(version.itemId)?.error && event?.eventType === "CONSENTED"
      && event.versionId === version.id && event.contentHash === version.contentHash
      && version.supplierId === (route?.supplierId ?? null)
      && version.recipientEmail === (route?.recipientEmail ?? "GPHKM_INTERNAL")) {
      chosen.set(version.itemId, { version, consent: event });
    }
  }

  for (const itemId of input.itemIds) {
    if (results.get(itemId)?.error) continue;
    const version = input.versions.find((row) => row.itemId === itemId);
    const selected = chosen.get(itemId);
    if (!selected) {
      if (version) results.set(itemId, { content: null, error: new Error("Supplier packet is blocked until the customer consents to the exact approved content and recipient") });
      continue;
    }
    const { version: current, consent } = selected;
    const listingTerms = termsByConsent.get(`${current.requestId}\0${current.contentHash}`);
    results.set(itemId, { content: Object.freeze({
      version: current.version,
      targetUrl: current.targetUrl,
      anchorText: current.anchorText,
      articleText: current.articleText,
      instructions: current.instructions,
      supplierId: current.supplierId,
      recipientEmail: current.recipientEmail,
      contentHash: current.contentHash,
      noticeVersion: consent.noticeVersion,
      consentedAt: consent.createdAt,
      ...(listingTerms !== undefined ? { listingTerms } : {}),
    }) });
  }
  return results;
}
