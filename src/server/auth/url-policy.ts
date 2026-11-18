type Environment = Record<string, string | undefined>;

const LEGACY_KEYS = ["APP_URL", "STAFF_URL", "CUSTOMER_URL", "BETTER_AUTH_URL"] as const;

export function assertNoLegacyAuthUrlVariables(env: Environment): void {
  for (const key of LEGACY_KEYS) {
    if (env[key]?.trim()) throw new Error(`${key} is not supported; use CUSTOMER_APP_URL and STAFF_APP_URL`);
  }
}

export function isRoutablePublicBase(value: string | undefined, env: Environment): boolean {
  if (!value?.trim()) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.hostname.includes("*") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return env.NODE_ENV !== "production" && url.protocol === "http:"
    && (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost"));
}

export function publicBaseOrigin(env: Environment): URL | null {
  const value = env.GPHKM_PUBLIC_BASE_URL?.trim();
  if (!value) return null;
  if (!isRoutablePublicBase(value, env)) throw new Error("GPHKM_PUBLIC_BASE_URL must be a routable HTTPS origin without credentials, path, query, or fragment");
  return new URL(value);
}

export function isPublicIngressHost(host: string, env: Environment): boolean {
  const base = publicBaseOrigin(env);
  return Boolean(base && base.host.toLowerCase() === host.trim().toLowerCase());
}
