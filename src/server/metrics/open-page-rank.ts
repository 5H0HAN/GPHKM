import "server-only";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

const ENDPOINT = "https://openpagerank.keywordseverywhere.com/v1/domains/bulk";
const MAX_RESPONSE_BYTES = 256 * 1024;
const API_KEY_PATTERN = /^[\x21-\x7e]{1,512}$/;

export function isOpenPageRankKeyValid(value: string | undefined): boolean {
  return typeof value === "string" && API_KEY_PATTERN.test(value);
}

export function isOpenPageRankConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return isOpenPageRankKeyValid(env.OPEN_PAGE_RANK_API_KEY);
}

export function normalizeMetricDomain(input: string): string {
  if (typeof input !== "string" || input.length > 1024) {
    throw new Error("Invalid metric domain");
  }
  const hostname = input.trim().toLowerCase().replace(/\.$/, "");
  if (/[\s/\\?#:@\[\]%\x00-\x1f\x7f]/.test(hostname)) throw new Error("Invalid metric domain");
  const domain = domainToASCII(hostname);
  const labels = domain.split(".");
  if (
    !domain || domain.length > 253 || isIP(domain) || labels.length < 2 ||
    !/[a-z]/.test(labels.at(-1)!) ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error("Invalid metric domain");
  }
  return domain;
}

export type OpenPageRankObservation = {
  provider: "OPEN_PAGE_RANK";
  scope: "REGISTERED_DOMAIN" | "HOST";
  requestedTarget: string;
  normalizedTarget: string;
  value: number | null;
  status: "available" | "missing";
  observedOn: string;
  refreshedAt: string;
  source: string;
};

// Internal provider boundary only. Future commands must check current staff authority.
export async function fetchOpenPageRank(inputs: readonly string[]): Promise<OpenPageRankObservation[]> {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100) {
    throw new Error("Open PageRank requires 1 to 100 domains");
  }
  const domains = [...new Set(inputs.map(normalizeMetricDomain))];
  const key = process.env.OPEN_PAGE_RANK_API_KEY;
  if (!isOpenPageRankKeyValid(key)) {
    throw new Error("OPEN_PAGE_RANK_API_KEY is missing or invalid");
  }

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domains, include_history: false }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Open PageRank HTTP ${response.status}`);
    }
    if (!response.headers.get("content-type")?.includes("application/json") || !response.body) {
      throw new Error("Invalid Open PageRank response");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error("Invalid Open PageRank response");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      typeof data.as_of !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.as_of) ||
      !Number.isFinite(Date.parse(data.as_of)) ||
      new Date(data.as_of).toISOString().slice(0, 10) !== data.as_of ||
      !Array.isArray(data.results) || data.results.length < 1 || data.results.length > domains.length ||
      data.count !== data.results.length ||
      (data.invalid !== undefined && (!Array.isArray(data.invalid) || data.invalid.length !== 0))
    ) throw new Error("Invalid Open PageRank response");

    const rowsByDomain = new Map<string, { found: boolean; value: number | null; hosts: Map<string, { found: boolean; value: number | null }> }>();
    const requestedDomains = new Set(domains);
    const isWithin = (host: string, root: string) => host === root || host.endsWith(`.${root}`);
    for (const row of data.results as Array<Record<string, unknown>>) {
      if (!row || typeof row.domain !== "string") throw new Error("Invalid Open PageRank response");
      const domain = normalizeMetricDomain(row.domain);
      if (
        rowsByDomain.has(domain) || !domains.some((requested) => isWithin(requested, domain)) ||
        typeof row.found !== "boolean" ||
        (row.found ? typeof row.open_page_rank !== "number" ||
          !Number.isFinite(row.open_page_rank) || row.open_page_rank < 0 || row.open_page_rank > 10
          : row.open_page_rank !== null)
      ) throw new Error("Invalid Open PageRank response");

      const hosts = new Map<string, { found: boolean; value: number | null }>();
      if (row.hosts !== undefined) {
        if (!Array.isArray(row.hosts) || row.hosts.length > domains.length) throw new Error("Invalid Open PageRank response");
        for (const entry of row.hosts as Array<Record<string, unknown>>) {
          if (!entry || typeof entry.host !== "string") throw new Error("Invalid Open PageRank response");
          const host = normalizeMetricDomain(entry.host);
          if (!isWithin(host, domain) || host === domain || !requestedDomains.has(host) || hosts.has(host) ||
            typeof entry.found !== "boolean" ||
            (entry.found ? typeof entry.open_page_rank !== "number" ||
              !Number.isFinite(entry.open_page_rank) || entry.open_page_rank < 0 || entry.open_page_rank > 10
              : entry.open_page_rank !== null)) throw new Error("Invalid Open PageRank response");
          hosts.set(host, { found: entry.found, value: entry.open_page_rank as number | null });
        }
      }
      rowsByDomain.set(domain, { found: row.found, value: row.open_page_rank as number | null, hosts });
    }

    const refreshedAt = new Date().toISOString();
    const observations = domains.map((requestedTarget): OpenPageRankObservation => {
      const domain = [...rowsByDomain.keys()].find((root) => isWithin(requestedTarget, root));
      const row = domain ? rowsByDomain.get(domain) : undefined;
      if (!domain || !row) throw new Error("Invalid Open PageRank response");
      const rootAlias = requestedTarget === domain || requestedTarget === `www.${domain}`;
      const host = rootAlias ? undefined : row.hosts.get(requestedTarget);
      if (!rootAlias && !host) throw new Error("Invalid Open PageRank response");
      const found = rootAlias ? row.found : host!.found;
      const value = rootAlias ? row.value : host!.value;
      return {
        provider: "OPEN_PAGE_RANK", scope: rootAlias ? "REGISTERED_DOMAIN" : "HOST",
        requestedTarget, normalizedTarget: rootAlias ? domain : requestedTarget,
        value, status: found ? "available" : "missing",
        observedOn: data.as_of, refreshedAt, source: ENDPOINT,
      };
    });
    return observations;
  } catch {
    // Do not propagate fetch/provider errors: they can contain credentials or echoed input.
    throw new Error("Open PageRank lookup failed");
  }
}
