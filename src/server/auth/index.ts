import "server-only";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError, addOAuthServerContext, createAuthMiddleware, getAuthoritativeSessionFromCtx, getOAuthState } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins/two-factor";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { normalizeDisplayName } from "@/server/identity/policy";
import { assertLoopbackUrl, authTrustedProxyCidrs, customerEmailSignupEnabled, customerSessionCreationAllowed, hasStrongAuthSecret, localAuthEnabled, localStaffMfaDisabled, requiredEnv, requiredMfaProofDatabaseUrl } from "./policy";
import { authSurfaceOrigins, type AuthSurface } from "./surfaces";
import { assertExplicitLegalAcceptance, currentLegalDocuments, LegalAcceptanceRequiredError, type LegalAcceptanceInput } from "@/modules/legal/policy";
import { stagingTesterEmails } from "@/modules/legal/staging-testers";
import { recordLegalAcceptance, requireCurrentLegalAcceptance } from "@/server/legal/acceptance";
import { authEmailAvailable, sendAuthEmailInBackground, sendCustomerWelcomeEmail } from "./email-delivery";
import { isCustomerAccountSuspended } from "@/server/identity/customer-access";
import { hashInvitationSecret } from "@/server/identity/invitation-token";
import { hasPendingStaffInvitation, resetTokenAllowedForSurface } from "./identity-domain";
import { customerUrl, resetPasswordUrl } from "./urls";
import { appendAuditEvent } from "@/server/audit/append";
import { logSafeEvent } from "@/server/observability/safe-log";

const CUSTOMER_SESSION_REVOCATION_PATHS = new Set([
  "/revoke-session",
  "/revoke-other-sessions",
  "/revoke-sessions",
]);
const CUSTOMER_SESSION_FRESH_AGE_MS = 10 * 60 * 1000;
const CUSTOMER_LEGAL_OAUTH_CONTEXT = "gphkmCustomerLegalConsent";
const TESTER_SESSION_ACTIONS = new Set(["/list-accounts", "/list-sessions", "/update-user", ...CUSTOMER_SESSION_REVOCATION_PATHS]);

function stagingTesterAllowed(email: unknown, verified: unknown): boolean {
  return verified === true && typeof email === "string" && stagingTesterEmails(process.env)?.has(email.toLowerCase()) === true;
}

function denyStagingAccess(): never {
  throw APIError.from("FORBIDDEN", { code: "STAGING_TESTER_REQUIRED", message: "Sign in with a designated Google test account." });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function legalAcceptanceFrom(value: unknown): LegalAcceptanceInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return { accepted: input.accepted, termsVersion: input.termsVersion, privacyVersion: input.privacyVersion };
}

function requireCustomerRegistrationAcceptance(input: LegalAcceptanceInput | null): LegalAcceptanceInput {
  let documents;
  try { documents = currentLegalDocuments(process.env); }
  catch { throw APIError.from("SERVICE_UNAVAILABLE", { code: "CUSTOMER_REGISTRATION_UNAVAILABLE", message: "Customer registration is temporarily unavailable" }); }
  try { assertExplicitLegalAcceptance(input ?? { accepted: undefined, termsVersion: undefined, privacyVersion: undefined }, documents); }
  catch (error) {
    if (error instanceof LegalAcceptanceRequiredError) {
      throw APIError.from("BAD_REQUEST", { code: "LEGAL_ACCEPTANCE_REQUIRED", message: "Accept the current Terms and Privacy Policy before creating an account" });
    }
    throw error;
  }
  return input!;
}

async function requireCurrentStaffInvitation(emailValue: unknown, tokenValue: unknown): Promise<void> {
  const email = typeof emailValue === "string" ? emailValue.trim().toLowerCase() : "";
  const token = typeof tokenValue === "string" ? tokenValue : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
    throw APIError.from("FORBIDDEN", { code: "STAFF_INVITATION_REQUIRED", message: "Staff registration requires a current invitation" });
  }
  const result = await db.execute(sql`select public.gphkm_staff_invitation_matches(${email}, ${hashInvitationSecret(token)}) as allowed`);
  const allowed = (result as unknown as { rows: Array<{ allowed: boolean }> }).rows[0]?.allowed;
  if (!allowed) {
    throw APIError.from("FORBIDDEN", { code: "STAFF_INVITATION_REQUIRED", message: "Staff registration requires a current invitation" });
  }
}

async function registrationAcceptanceForContext(context: { path?: string; body?: unknown } | null): Promise<LegalAcceptanceInput | null> {
  if (!context) return null;
  if (context.path === "/sign-up/email") return legalAcceptanceFrom(asRecord(context.body).legalConsent);
  if (context.path === "/sign-in/social") return legalAcceptanceFrom(asRecord(asRecord(context.body).additionalData).legalConsent);
  if (context.path?.startsWith("/callback/")) {
    const state = await getOAuthState();
    return legalAcceptanceFrom(asRecord(state?.serverContext)[CUSTOMER_LEGAL_OAUTH_CONTEXT]);
  }
  return null;
}

function createAuth(surface: AuthSurface) {
  if (process.env.BETTER_AUTH_TRUSTED_ORIGINS?.trim()) throw new Error("BETTER_AUTH_TRUSTED_ORIGINS is not supported; configure the exact surface origins");
  if (process.env.BETTER_AUTH_SECRETS?.trim()) throw new Error("BETTER_AUTH_SECRETS is not supported; configure BETTER_AUTH_SECRET");
  const local = localAuthEnabled(process.env);
  const testerOnly = surface === "customer" && process.env.GPHKM_STAGING_TESTER_NOTICES_ENABLED === "true";
  let stagingDocuments: ReturnType<typeof currentLegalDocuments> | undefined;
  if (surface === "customer" && process.env.GPHKM_DEPLOYMENT_ENV === "staging") {
    try { stagingDocuments = currentLegalDocuments(process.env); } catch { /* Closed until valid documents are configured. */ }
  }
  const stagingSignInClosed = surface === "customer" && process.env.GPHKM_DEPLOYMENT_ENV === "staging" && !stagingDocuments;
  const staffMfaBypassed = surface === "staff" && localStaffMfaDisabled(process.env);
  if (surface === "staff" && !staffMfaBypassed) requiredMfaProofDatabaseUrl(process.env);
  const publicCustomerCredentials = surface === "customer" && customerEmailSignupEnabled(process.env) && authEmailAvailable();
  const resetIdentifier = (identifier: string) => createHash("sha256").update(`gphkm:${surface}:${identifier}`).digest("hex");
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
  const googleId = process.env.GOOGLE_CLIENT_ID?.trim();
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (surface === "customer" && Boolean(googleId) !== Boolean(googleSecret)) {
    throw new Error("Google authentication requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  }
  // Separate buckets prevent customer traffic from exhausting staff sign-in
  // limits (and vice versa), while both remain durable in PostgreSQL.
  const authSchema = { ...schema, rateLimit: surface === "staff" ? schema.staffRateLimit : schema.rateLimit };
  return betterAuth({
    appName: "GPHKM",
    // Ordinary customer and staff cookies must never authenticate a tester session.
    secret: testerOnly ? createHmac("sha256", secret).update("gphkm:staging:google-testers:v1:" + JSON.stringify(stagingDocuments)).digest("base64") : secret,
    baseURL,
    trustedOrigins: [url.origin],
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema, transaction: true }),
    verification: { storeIdentifier: { default: "plain", overrides: { "reset-password:": { hash: async (identifier) => resetIdentifier(identifier) } } } },
    logger: { level: "error", log: () => { console.error(JSON.stringify({ event: "auth_library_error" })); } },
    emailAndPassword: {
      enabled: !testerOnly,
      disableSignUp: surface === "staff" ? false : !publicCustomerCredentials,
      requireEmailVerification: surface === "customer",
      minPasswordLength: 16,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        if (!await resetTokenAllowedForSurface(user.id, surface)) return;
        const link = resetPasswordUrl(process.env, surface, token);
        sendAuthEmailInBackground({ kind: "password_reset", to: user.email, subject: surface === "staff" ? "Reset your GPHKM staff password" : "Reset your GPHKM password", text: `Use this one-time link to reset your GPHKM password:\n\n${link}\n\nIf you did not request this, ignore this email. The link expires automatically.` });
      },
      onPasswordReset: async ({ user }) => {
        await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, user.id));
        try {
          await db.transaction(async (tx) => {
            await tx.execute(sql`select set_config('app.user_id', ${user.id}, true)`);
            await appendAuditEvent(tx, { actorUserId: user.id, action: "auth.password_reset_completed", targetType: "auth_user", targetId: user.id, metadata: { result: surface } });
          });
        } catch { logSafeEvent("auth_password_reset_audit_failed", randomUUID(), { surface }); }
      },
    },
    emailVerification: {
      sendOnSignUp: publicCustomerCredentials,
      sendOnSignIn: publicCustomerCredentials,
      autoSignInAfterVerification: true,
      afterEmailVerification: async (user) => {
        if (surface === "customer") sendCustomerWelcomeEmail(user.email, customerUrl(process.env, "/sign-in"));
      },
      sendVerificationEmail: async ({ user, url }) => {
        const subject = surface === "staff" ? "Verify your GPHKM staff email" : "Verify your GPHKM email";
        const purpose = surface === "staff" ? "accepting your staff invitation" : "setting up your GPHKM account";
        sendAuthEmailInBackground({ kind: "verification", to: user.email, subject, text: `Verify your email address before ${purpose}:\n\n${url}\n\nIf you did not create this account, ignore this email.` });
      },
    },
    socialProviders: surface === "customer" && googleId && googleSecret ? { google: {
      clientId: googleId, clientSecret: googleSecret, disableImplicitSignUp: true,
      ...(testerOnly ? { mapProfileToUser: (profile) => {
        if (!stagingTesterAllowed(profile.email, profile.email_verified)) denyStagingAccess();
        return {};
      } } : {}),
    } } : {},
    account: { accountLinking: { enabled: false } },
    session: { freshAge: 10 * 60, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: "database", modelName: "rateLimit" },
    advanced: { cookiePrefix: surface === "staff" ? "gphkm-staff" : "gphkm-customer", ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies }, crossSubDomainCookies: { enabled: false }, defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: url.protocol === "https:", path: "/" } },
    plugins: surface === "customer" || !staffMfaBypassed ? [twoFactor({ issuer: surface === "staff" ? "GPHKM Staff" : "GPHKM", trustDeviceMaxAge: 0, allowPasswordless: false, backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: "encrypted" } })] : [],
    disabledPaths: ["/delete-user", "/change-email", "/two-factor/get-totp-uri", "/two-factor/send-otp", "/two-factor/verify-otp", ...(surface === "staff" ? ["/set-password", "/change-password", "/two-factor/disable"] : [])],
    hooks: {
      before: createAuthMiddleware(async (context) => {
        const body = asRecord(context.body);
        if (surface === "customer" && ["/sign-in/social", "/link-social"].includes(context.path ?? "") && body.provider === "google"
          && body.scopes !== undefined && (!Array.isArray(body.scopes) || body.scopes.length > 0)) {
          throw APIError.from("BAD_REQUEST", { code: "GOOGLE_CUSTOM_SCOPES_UNSUPPORTED", message: "Google sign-in supports basic identity scopes only" });
        }
        if (stagingSignInClosed && context.path !== "/get-session" && context.path !== "/sign-out") {
          throw APIError.from("FORBIDDEN", { code: "STAGING_SIGN_IN_CLOSED", message: "Customer sign-in is closed for this staging environment." });
        }
        if (testerOnly) {
          const googleSignIn = context.path === "/sign-in/social" && body.provider === "google" && !body.idToken && !body.scopes;
          const googleCallback = context.path === "/callback/:id" && context.params?.id === "google";
          if (googleSignIn || googleCallback) {
            if (!stagingTesterEmails(process.env)) denyStagingAccess();
          } else if (TESTER_SESSION_ACTIONS.has(context.path)) {
            const session = await getAuthoritativeSessionFromCtx(context);
            if (!stagingTesterAllowed(session?.user.email, session?.user.emailVerified)) denyStagingAccess();
          } else if (!["/get-session", "/sign-out", "/error"].includes(context.path)) {
            denyStagingAccess();
          }
        }
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
        if (surface === "customer" && context.path === "/sign-up/email") {
          requireCustomerRegistrationAcceptance(legalAcceptanceFrom(asRecord(context.body).legalConsent));
        }
        if (surface === "staff" && context.path === "/sign-up/email") {
          const body = asRecord(context.body);
          await requireCurrentStaffInvitation(body.email, (context.headers ?? context.request?.headers)?.get("x-gphkm-staff-invitation-token"));
          try {
            body.name = normalizeDisplayName(typeof body.name === "string" ? body.name : "");
          } catch {
            throw APIError.from("BAD_REQUEST", { code: "STAFF_NAME_INVALID", message: "Enter a valid name" });
          }
        }
        if (context.path === "/reset-password") {
          const token = asRecord(context.body).token;
          if (typeof token !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw APIError.from("BAD_REQUEST", { code: "INVALID_TOKEN", message: "Invalid or expired reset link" });
          const [record] = await db.select({ userId: schema.verification.value, expiresAt: schema.verification.expiresAt }).from(schema.verification).where(eq(schema.verification.identifier, resetIdentifier(`reset-password:${token}`))).limit(1);
          if (!record || record.expiresAt.getTime() <= Date.now() || !await resetTokenAllowedForSurface(record.userId, surface)) throw APIError.from("BAD_REQUEST", { code: "INVALID_TOKEN", message: "Invalid or expired reset link" });
        }
        if (context.path.startsWith("/two-factor/") && asRecord(context.body).trustDevice === true) throw APIError.from("BAD_REQUEST", { code: "TRUSTED_DEVICE_DISABLED", message: "Trusted devices are unavailable" });
        if (surface === "customer" && context.path === "/sign-in/social" && asRecord(context.body).requestSignUp === true) {
          const accepted = requireCustomerRegistrationAcceptance(legalAcceptanceFrom(asRecord(asRecord(context.body).additionalData).legalConsent));
          await addOAuthServerContext({ [CUSTOMER_LEGAL_OAUTH_CONTEXT]: accepted });
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
      after: createAuthMiddleware(async (context) => {
        if (stagingSignInClosed && context.path === "/get-session") return context.json(null);
        if (testerOnly && context.path === "/get-session") {
          const result = asRecord(context.context.returned);
          if (result.user) {
            const user = asRecord(result.user);
            if (!stagingTesterAllowed(user.email, user.emailVerified)) return context.json(null);
          }
        }
      }),
    },
    databaseHooks: {
      user: { create: {
        before: async (newUser, context) => {
        if (testerOnly && (context?.path !== "/callback/:id" || context.params?.id !== "google" || !stagingTesterAllowed(newUser.email, newUser.emailVerified))) denyStagingAccess();
        if (surface === "customer") requireCustomerRegistrationAcceptance(await registrationAcceptanceForContext(context));
        if (surface === "staff") {
          if (context?.path !== "/sign-up/email") throw APIError.from("FORBIDDEN", { code: "STAFF_INVITATION_REQUIRED", message: "Staff registration requires a current invitation" });
          await requireCurrentStaffInvitation(newUser.email, (context.headers ?? context.request?.headers)?.get("x-gphkm-staff-invitation-token"));
          return { data: { ...newUser, email: newUser.email.trim().toLowerCase(), name: normalizeDisplayName(newUser.name), emailVerified: true } };
        }
        },
        after: async (newUser, context) => {
          if (surface !== "customer") return;
          const accepted = requireCustomerRegistrationAcceptance(await registrationAcceptanceForContext(context));
          await db.transaction(async (tx) => {
            await tx.execute(sql`select set_config('app.user_id', ${newUser.id}, true)`);
            await recordLegalAcceptance(tx, newUser.id, accepted);
          });
          if (newUser.emailVerified) sendCustomerWelcomeEmail(newUser.email, customerUrl(process.env, "/sign-in"));
        },
      } },
      session: { create: { before: async (session, context) => {
        if (testerOnly && (context?.path !== "/callback/:id" || context.params?.id !== "google")) denyStagingAccess();
        // Better Auth creates the invited user and first session in one
        // transaction. The invitation was checked in user.create.before.
        if (surface === "staff" && context?.path === "/sign-up/email") return;
        const { staff, account } = await db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.user_id', ${session.userId}, true)`);
          const [staff] = await tx.select({ active: schema.staffAccount.active }).from(schema.staffAccount).where(eq(schema.staffAccount.userId, session.userId)).limit(1);
          const [account] = await tx.select({ email: schema.user.email, emailVerified: schema.user.emailVerified, twoFactorEnabled: schema.user.twoFactorEnabled }).from(schema.user).where(eq(schema.user.id, session.userId)).limit(1);
          return { staff, account };
        });
        if (!account) return false;
        if (surface === "customer") {
          if (staff) throw APIError.from("FORBIDDEN", { code: "STAFF_IDENTITY_ON_CUSTOMER_SURFACE", message: "Use the staff workspace to sign in" });
          if (testerOnly && !stagingTesterAllowed(account.email, account.emailVerified)) denyStagingAccess();
          if (await isCustomerAccountSuspended(session.userId)) return false;
          if (!customerSessionCreationAllowed(context?.path, account.twoFactorEnabled)) throw APIError.from("FORBIDDEN", { code: "TWO_FACTOR_REQUIRED", message: "Sign in with email and password and verify your authenticator" });
          if (testerOnly) {
            // A returning Google account may predate this notice version or a failed acceptance write.
            const consent = await registrationAcceptanceForContext(context);
            await db.transaction(async (tx) => {
              await tx.execute(sql`select set_config('app.user_id', ${session.userId}, true)`);
              if (consent) await recordLegalAcceptance(tx, session.userId, requireCustomerRegistrationAcceptance(consent));
              else {
                try { await requireCurrentLegalAcceptance(tx, session.userId); }
                catch (error) {
                  if (!(error instanceof LegalAcceptanceRequiredError)) throw error;
                  throw APIError.from("FORBIDDEN", { code: "LEGAL_ACCEPTANCE_REQUIRED", message: "Choose Create an account to accept the current staging tester notices." });
                }
              }
            });
          }
        } else {
          if (!staff && !await hasPendingStaffInvitation(account.email)) return false;
          if (!staffMfaBypassed && !customerSessionCreationAllowed(context?.path, account.twoFactorEnabled)) {
            throw APIError.from("FORBIDDEN", { code: "TWO_FACTOR_REQUIRED", message: "Verify your staff authenticator before signing in" });
          }
        }
      } } },
    },
  });
}

const instances: Partial<Record<AuthSurface, ReturnType<typeof createAuth>>> = {};

export function getAuthForSurface(surface: AuthSurface) {
  // Recheck even with a cached instance: the local opt-in must never run outside development.
  localAuthEnabled(process.env);
  return instances[surface] ??= createAuth(surface);
}
