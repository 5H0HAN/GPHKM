import { isIP } from "node:net";
import { authSurfaceOrigins } from "./surfaces.ts";

type Environment = Record<string, string | undefined>;

export function requiredEnv(env: Environment, key: string): string {
  const value = env[key];
  if (!value || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

export function hasStrongAuthSecret(secret: string): boolean {
  let bytes: Buffer;
  if (/^(?:[0-9a-fA-F]{2}){32,}$/.test(secret)) {
    bytes = Buffer.from(secret, "hex");
  } else {
    bytes = Buffer.from(secret, "base64");
    if (bytes.length < 32 || bytes.toString("base64") !== secret) {
      bytes = Buffer.from(secret, "base64url");
      if (bytes.length < 32 || bytes.toString("base64url") !== secret) return false;
    }
  }
  // Catch accidentally repeated/low-complexity values; this cannot prove how
  // a secret was generated, so deployers must still use a CSPRNG.
  return bytes.length >= 32 && new Set(bytes).size >= 16;
}

export function localAuthEnabled(env: Environment): boolean {
  const flag = env.GPHKM_LOCAL_AUTH_ENABLED;
  if (flag !== undefined && flag !== "true" && flag !== "false") {
    throw new Error("GPHKM_LOCAL_AUTH_ENABLED must be true or false");
  }
  if (flag === "true" && env.NODE_ENV !== "development") {
    throw new Error("Local credential authentication requires NODE_ENV=development");
  }
  return flag === "true";
}

export function localStaffMfaDisabled(env: Environment): boolean {
  const flag = env.GPHKM_LOCAL_MFA_DISABLED;
  if (flag !== undefined && flag !== "true" && flag !== "false") {
    throw new Error("GPHKM_LOCAL_MFA_DISABLED must be true or false");
  }
  if (flag === "true" && (env.NODE_ENV !== "development" || !localAuthEnabled(env))) {
    throw new Error("Local staff MFA may be disabled only with development-only local authentication");
  }
  return flag === "true";
}

export function authTrustedProxyCidrs(env: Environment): string[] {
  const configured = env.GPHKM_TRUSTED_PROXY_CIDRS?.trim();
  if (!configured) {
    if (env.NODE_ENV === "production") throw new Error("GPHKM_TRUSTED_PROXY_CIDRS is required in production");
    return [];
  }

  const ranges = configured.split(",").map((value) => value.trim());
  if (ranges.length > 32 || ranges.some((range) => {
    const parts = range.split("/");
    if (parts.length > 2) return true;
    const family = isIP(parts[0] ?? "");
    if (!family) return true;
    if (parts.length === 1) return false;
    if (!/^\d{1,3}$/.test(parts[1] ?? "")) return true;
    const prefix = Number(parts[1]);
    return prefix < 1 || prefix > (family === 4 ? 32 : 128);
  })) throw new Error("GPHKM_TRUSTED_PROXY_CIDRS must contain at most 32 valid IP addresses or CIDRs and must not trust every address");

  return [...new Set(ranges)];
}

export function assertLoopbackUrl(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a valid URL`); }
  if (url.hostname.includes("*") || (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.hostname.endsWith(".localhost"))) {
    throw new Error(`${label} must use a loopback hostname`);
  }
  return url;
}

export function bootstrapSettings(env: Environment) {
  if (!localAuthEnabled(env)) throw new Error("Local credential authentication must be enabled");
  const appOrigins = authSurfaceOrigins(env);
  const customerOrigin = assertLoopbackUrl(appOrigins.customer, "CUSTOMER_APP_URL");
  const staffOrigin = assertLoopbackUrl(appOrigins.staff, "STAFF_APP_URL");
  if (!["http:", "https:"].includes(customerOrigin.protocol) || !["http:", "https:"].includes(staffOrigin.protocol)) {
    throw new Error("Invalid customer/staff app URL protocol");
  }
  const databaseUrl = requiredEnv(env, "MIGRATION_DATABASE_URL");
  const database = assertLoopbackUrl(databaseUrl, "MIGRATION_DATABASE_URL");
  if (!["postgres:", "postgresql:"].includes(database.protocol)) throw new Error("Invalid database protocol");
  const email = requiredEnv(env, "BOOTSTRAP_SUPER_ADMIN_EMAIL").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid bootstrap email");
  const password = requiredEnv(env, "BOOTSTRAP_SUPER_ADMIN_PASSWORD");
  if (password.length < 16 || password.length > 128) throw new Error("Bootstrap password must contain 16–128 characters");
  const customerEmail = requiredEnv(env, "BOOTSTRAP_CUSTOMER_EMAIL").trim().toLowerCase();
  const customerPassword = requiredEnv(env, "BOOTSTRAP_CUSTOMER_PASSWORD");
  if (!/^[^\s@]+@[^\s@]+\.test$/.test(email) || !/^[^\s@]+@[^\s@]+\.test$/.test(customerEmail)) {
    throw new Error("Local bootstrap identities must use reserved .test email domains");
  }
  if (email === customerEmail) throw new Error("Staff and customer must have separate identities");
  if (customerPassword.length < 16 || customerPassword.length > 128) {
    throw new Error("Customer bootstrap password must contain 16–128 characters");
  }
  return { email, password, customerEmail, customerPassword, databaseUrl, customerAppUrl: appOrigins.customer, staffAppUrl: appOrigins.staff };
}

export function assertBootstrapAvailable(hasStaff: boolean, hasBootstrap: boolean, hasUser: boolean): void {
  if (hasBootstrap) throw new Error("Initial staff bootstrap has already been used");
  if (hasStaff) throw new Error("A staff account already exists");
  if (hasUser) throw new Error("Bootstrap cannot elevate an existing account");
}
