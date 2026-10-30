import "server-only";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins/two-factor";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { normalizeDisplayName } from "@/server/identity/policy";
import { assertLoopbackUrl, authTrustedProxyCidrs, hasStrongAuthSecret, localAuthEnabled, localStaffMfaDisabled, requiredEnv } from "./policy";
import { authSurfaceOrigins, type AuthSurface } from "./surfaces";
import { currentLegalDocuments } from "@/modules/legal/policy";
import { customerAuthEmailAvailable, sendCustomerAuthEmailInBackground } from "./email-delivery";

const CUSTOMER_SESSION_REVOCATION_PATHS = new Set([
  "/revoke-session",
  "/revoke-other-sessions",
  "/revoke-sessions",
]);
const CUSTOMER_SESSION_FRESH_AGE_MS = 10 * 60 * 1000;

function createAuth(surface: AuthSurface) {
  const local = localAuthEnabled(process.env);
  const publicCustomerCredentials = surface === "customer" && process.env.NODE_ENV !== "development" && customerAuthEmailAvailable();
  const localMfaDisabled = surface === "staff" && localStaffMfaDisabled(process.env);
  const origins = authSurfaceOrigins(process.env);
  const baseURL = origins[surface];
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new Error(`${surface.toUpperCase()}_APP_URL must be a valid URL`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${surface.toUpperCase()}_APP_URL must be an HTTP(S) URL without credentials`);
  }
  if (local) {
    assertLoopbackUrl(baseURL, `${surface.toUpperCase()}_APP_URL`);
    assertLoopbackUrl(requiredEnv(process.env, "DATABASE_URL"), "DATABASE_URL");
  } else if (url.protocol !== "https:") {
    throw new Error("Non-local authentication requires HTTPS");
  }
  const secret = requiredEnv(process.env, "BETTER_AUTH_SECRET");
  const trustedProxies = authTrustedProxyCidrs(process.env);
  if (local ? secret.length < 32 : !hasStrongAuthSecret(secret)) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 cryptographically random bytes encoded as hex or base64");
  }
  const googleId = process.env.GOOGLE_CLIENT_ID;
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
  if ((googleId && !googleSecret) || (!googleId && googleSecret) || (!local && !googleId)) {
    throw new Error("Google authentication requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  }
  // Separate buckets prevent customer traffic from exhausting staff sign-in
  // limits (and vice versa), while both remain durable in PostgreSQL.
  const authSchema = { ...schema, rateLimit: surface === "staff" ? schema.staffRateLimit : schema.rateLimit };
  const staffTwoFactorManagementPaths = new Set([
    "/two-factor/enable",
    "/two-factor/generate-backup-codes",
  ]);
  return betterAuth({
    appName: "GPHKM",
    secret,
    baseURL,
    trustedOrigins: [url.origin],
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema, transaction: true }),
    emailAndPassword: {
      enabled: local || surface === "customer",
      disableSignUp: surface === "staff" || !publicCustomerCredentials,
      requireEmailVerification: true,
      minPasswordLength: 16,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: surface === "customer" ? async ({ user, token }) => {
        const resetUrl = new URL("/sign-in/reset-password", baseURL);
        resetUrl.hash = new URLSearchParams({ token }).toString();
        sendCustomerAuthEmailInBackground({ to: user.email, subject: "Reset your GPHKM password", text: `Use this one-time link to reset your GPHKM password:\n\n${resetUrl.toString()}\n\nIf you did not request this, ignore this email. The link expires automatically.` });
      } : undefined,
    },
    emailVerification: surface === "customer" ? {
      sendOnSignUp: publicCustomerCredentials,
      sendOnSignIn: publicCustomerCredentials,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        sendCustomerAuthEmailInBackground({ to: user.email, subject: "Verify your GPHKM email", text: `Verify your email address to continue setting up your GPHKM account:\n\n${url}\n\nIf you did not create this account, ignore this email.` });
      },
    } : undefined,
    socialProviders: googleId && googleSecret ? { google: { clientId: googleId, clientSecret: googleSecret } } : {},
    account: { accountLinking: { enabled: false } },
    session: { freshAge: 10 * 60, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: "database", modelName: "rateLimit" },
    advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies } },
    // Staff must verify MFA every session; trusted-device bypass is deliberately expired immediately.
    plugins: localMfaDisabled ? [] : [twoFactor({ issuer: "GPHKM", trustDeviceMaxAge: 0 })],
    // No public credential provisioning, password recovery email transport, or MFA removal in this slice.
    disabledPaths: ["/two-factor/disable", "/delete-user", "/change-email", "/set-password", ...(surface === "staff" ? ["/request-password-reset", "/reset-password"] : [])],
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (surface === "customer" && CUSTOMER_SESSION_REVOCATION_PATHS.has(context.path)) {
          // Better Auth's built-in revocation endpoints require a valid session
          // but do not all enforce freshAge. Guard the catch-all HTTP routes and
          // auth.api calls here so no caller can bypass the recent-auth check.
          const headers = context.headers ?? context.request?.headers;
          if (!headers) {
            throw APIError.from("UNAUTHORIZED", { code: "SESSION_REQUIRED", message: "A current session is required" });
          }
          const authenticated = await getAuthForSurface("customer").api.getSession({ headers });
          const createdAt = authenticated ? new Date(authenticated.session.createdAt).getTime() : Number.NaN;
          if (!authenticated || !Number.isFinite(createdAt)) {
            throw APIError.from("UNAUTHORIZED", { code: "SESSION_REQUIRED", message: "A current session is required" });
          }
          if (Date.now() - createdAt >= CUSTOMER_SESSION_FRESH_AGE_MS) {
            throw APIError.from("FORBIDDEN", { code: "SESSION_NOT_FRESH", message: "Sign in again before changing active sessions" });
          }
        }
        if (surface === "staff" && staffTwoFactorManagementPaths.has(context.path)) {
          const request = context.request;
          if (!request) {
            throw APIError.from("UNAUTHORIZED", { code: "STAFF_ACCOUNT_REQUIRED", message: "Staff account unavailable" });
          }
          const authenticated = await getAuthForSurface("staff").api.getSession({ headers: request.headers });
          if (!authenticated) {
            throw APIError.from("UNAUTHORIZED", { code: "STAFF_ACCOUNT_REQUIRED", message: "Staff account unavailable" });
          }
          const [staff] = await db.transaction(async (tx) => {
            await tx.execute(sql`select set_config('app.user_id', ${authenticated.user.id}, true)`);
            return tx.select({ userId: schema.staffAccount.userId })
              .from(schema.staffAccount)
              .where(eq(schema.staffAccount.userId, authenticated.user.id))
              .limit(1);
          });
          if (!staff) {
            throw APIError.from("FORBIDDEN", { code: "STAFF_ACCOUNT_REQUIRED", message: "Staff account unavailable" });
          }
        }
        if (surface === "customer" && context.path === "/sign-in/social") {
          try { currentLegalDocuments(process.env); }
          catch { throw APIError.from("SERVICE_UNAVAILABLE", { code: "CUSTOMER_REGISTRATION_UNAVAILABLE", message: "Customer registration is temporarily unavailable" }); }
        }
        if (surface === "customer" && context.path === "/sign-up/email") {
          try { currentLegalDocuments(process.env); }
          catch { throw APIError.from("SERVICE_UNAVAILABLE", { code: "CUSTOMER_REGISTRATION_UNAVAILABLE", message: "Customer registration is temporarily unavailable" }); }
        }
        if (context.path === "/update-user") {
          const body = context.body;
          if (Object.keys(body).some((key) => key !== "name") || typeof body.name !== "string") {
            throw APIError.from("BAD_REQUEST", { code: "PROFILE_FIELDS_RESTRICTED", message: "Only the display name can be changed here" });
          }
          try {
            body.name = normalizeDisplayName(body.name);
          } catch {
            throw APIError.from("BAD_REQUEST", { code: "PROFILE_NAME_INVALID", message: "Display name must be 1–100 safe characters" });
          }
        }
      }),
    },
    databaseHooks: {
      user: { create: { before: async (newUser) => {
        if (surface === "customer") currentLegalDocuments(process.env);
        if (surface === "staff") {
          const email = typeof newUser.email === "string" ? newUser.email.trim().toLowerCase() : "";
          const { rows } = await db.execute(sql`select public.gphkm_staff_email_has_pending_invitation(${email}) as allowed`);
          if (!(rows as Array<{ allowed: boolean }>)[0]?.allowed) {
            throw APIError.from("FORBIDDEN", { code: "STAFF_INVITATION_REQUIRED", message: "Staff registration requires a current invitation" });
          }
        }
      } } },
      session: { create: { before: async (session) => {
        const [staff] = await db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.user_id', ${session.userId}, true)`);
          return tx.select({ active: schema.staffAccount.active })
            .from(schema.staffAccount).where(eq(schema.staffAccount.userId, session.userId)).limit(1);
        });
        // Pending staff need a session to enroll TOTP before activation. All
        // staff data and commands still require active status and MFA proof.
        if (staff && !staff.active && surface !== "staff") return false;
      } } },
    },
  });
}

const instances: Partial<Record<AuthSurface, ReturnType<typeof createAuth>>> = {};

export function getAuthForSurface(surface: AuthSurface) {
  // Recheck even with a cached instance: the local opt-in must never run outside development.
  localAuthEnabled(process.env);
  localStaffMfaDisabled(process.env);
  return instances[surface] ??= createAuth(surface);
}
