type Environment = Record<string, string | undefined>;
export type AuthSurface = "customer" | "staff";

function configuredOrigin(env: Environment, key: string): URL {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${key} must be a valid URL`); }
  if (url.hostname.includes("*") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${key} must be an origin without credentials, path, query, or fragment`);
  }
  if (env.NODE_ENV === "production" && url.protocol !== "https:") throw new Error(`${key} must use HTTPS`);
  if (env.NODE_ENV !== "production" && url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${key} must use HTTP(S)`);
  }
  if (env.NODE_ENV !== "production" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.hostname.endsWith(".localhost")) {
    throw new Error(`${key} must use a loopback host outside production`);
  }
  return url;
}

export function authSurfaceOrigins(env: Environment): { customer: string; staff: string } {
  const customer = configuredOrigin(env, "CUSTOMER_APP_URL");
  const staff = configuredOrigin(env, "STAFF_APP_URL");
  if (customer.origin === staff.origin || customer.hostname === staff.hostname) {
    throw new Error("Customer and staff app hostnames must be distinct; cookies do not isolate by port");
  }
  return { customer: customer.origin, staff: staff.origin };
}

export function authSurfaceForHost(host: string, origins: { customer: string; staff: string }): AuthSurface | null {
  const normalized = host.trim().toLowerCase();
  for (const surface of ["customer", "staff"] as const) {
    if (new URL(origins[surface]).host.toLowerCase() === normalized) return surface;
  }
  return null;
}

export function resolveAuthSurface(headers: Headers, env: Environment): AuthSurface | null {
  const host = headers.get("host");
  if (!host) return null;
  return authSurfaceForHost(host, authSurfaceOrigins(env));
}

export function assertAuthSurface(host: string, surface: AuthSurface, origins: { customer: string; staff: string }): void {
  if (authSurfaceForHost(host, origins) !== surface) throw new Error("Forbidden");
}
