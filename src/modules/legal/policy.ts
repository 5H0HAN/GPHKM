import { stagingTesterEmails, stagingTesterVersions } from "./staging-testers.ts";

export type LegalDocuments = {
  termsVersion: string;
  privacyVersion: string;
  termsUrl: string;
  privacyUrl: string;
};
export type LegalAcceptanceInput = { accepted: unknown; termsVersion: unknown; privacyVersion: unknown };

const stagingReviewTermsVersion = "terms-staging-review";
const stagingReviewPrivacyVersion = "privacy-staging-review";

export class LegalConfigurationError extends Error {
  constructor() { super("Customer legal documents are not configured"); }
}
export class LegalAcceptanceRequiredError extends Error {
  constructor() { super("Current Terms and Privacy acceptance is required"); }
}

function version(value: string | undefined, development: boolean): string {
  const result = value?.trim() ?? "";
  if (/staging-testers|(?:^|[-_.:])draft(?:$|[-_.:])/i.test(result) ||
    /^(terms|privacy)-2026-11-19-v1$/.test(result) || (!development && /^local-test(?:-|$)/i.test(result)) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(result)) throw new LegalConfigurationError();
  return result;
}

function documentUrl(value: string | undefined, development: boolean): string {
  let url: URL;
  try { url = new URL(value?.trim() ?? ""); } catch { throw new LegalConfigurationError(); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost");
  if (url.toString().length > 2048 || url.username || url.password || url.hostname.includes("*") ||
    url.pathname.startsWith("/legal/drafts/") || url.pathname.startsWith("/legal/testing/") ||
    (!development && loopback) ||
    (url.protocol !== "https:" && !(development && loopback && url.protocol === "http:"))) throw new LegalConfigurationError();
  return url.toString();
}

export function currentLegalDocuments(env: Record<string, string | undefined>): LegalDocuments {
  const testerFlag = env.GPHKM_STAGING_TESTER_NOTICES_ENABLED;
  const reviewFlag = env.GPHKM_STAGING_REVIEW_NOTICES_ENABLED;
  if ((testerFlag !== undefined && testerFlag !== "true" && testerFlag !== "false") ||
    (reviewFlag !== undefined && reviewFlag !== "true" && reviewFlag !== "false") ||
    (testerFlag === "true" && reviewFlag === "true")) throw new LegalConfigurationError();
  if (testerFlag === "true") {
    if (!stagingTesterEmails(env)) throw new LegalConfigurationError();
    const { terms, privacy } = stagingTesterVersions;
    const origin = env.CUSTOMER_APP_URL;
    return {
      termsVersion: terms, privacyVersion: privacy,
      termsUrl: new URL(`/legal/testing/${terms}`, origin).href,
      privacyUrl: new URL(`/legal/testing/${privacy}`, origin).href,
    };
  }
  if (reviewFlag === "true") {
    if (env.GPHKM_DEPLOYMENT_ENV !== "staging" || env.GPHKM_REAL_MONEY_ENABLED !== "false" ||
      env.GPHKM_LAUNCH_GATES_VERIFIED !== "false" || env.GPHKM_LOCAL_AUTH_ENABLED === "true" ||
      env.GPHKM_LOCAL_MFA_DISABLED === "true") throw new LegalConfigurationError();
    let customerOrigin: URL;
    let staffOrigin: URL;
    try {
      customerOrigin = new URL(env.CUSTOMER_APP_URL ?? "");
      staffOrigin = new URL(env.STAFF_APP_URL ?? "");
    } catch { throw new LegalConfigurationError(); }
    if (customerOrigin.protocol !== "https:" || staffOrigin.protocol !== "https:" ||
      customerOrigin.username || customerOrigin.password || staffOrigin.username || staffOrigin.password ||
      customerOrigin.pathname !== "/" || customerOrigin.search || customerOrigin.hash ||
      staffOrigin.pathname !== "/" || staffOrigin.search || staffOrigin.hash) throw new LegalConfigurationError();
    const origin = customerOrigin.origin;
    return {
      termsVersion: stagingReviewTermsVersion,
      privacyVersion: stagingReviewPrivacyVersion,
      termsUrl: new URL("/legal/staging/terms", origin).href,
      privacyUrl: new URL("/legal/staging/privacy", origin).href,
    };
  }
  const development = env.NODE_ENV === "development";
  return {
    termsVersion: version(env.GPHKM_TERMS_VERSION, development), privacyVersion: version(env.GPHKM_PRIVACY_VERSION, development),
    termsUrl: documentUrl(env.GPHKM_TERMS_URL, development),
    privacyUrl: documentUrl(env.GPHKM_PRIVACY_URL, development),
  };
}

export function usesStagingTesterNotices(documents: LegalDocuments | null): boolean {
  return documents?.termsVersion === stagingTesterVersions.terms && documents.privacyVersion === stagingTesterVersions.privacy;
}

export function usesStagingReviewNotices(documents: LegalDocuments | null): boolean {
  return documents?.termsVersion === stagingReviewTermsVersion && documents.privacyVersion === stagingReviewPrivacyVersion;
}

export function assertExplicitLegalAcceptance(input: LegalAcceptanceInput, documents: LegalDocuments): void {
  if (input.accepted !== true || input.termsVersion !== documents.termsVersion || input.privacyVersion !== documents.privacyVersion) {
    throw new LegalAcceptanceRequiredError();
  }
}

export function matchesCurrentLegalAcceptance(acceptance: { termsVersion: string; privacyVersion: string; termsUrl: string; privacyUrl: string } | null | undefined, documents: LegalDocuments): boolean {
  return Boolean(acceptance && acceptance.termsVersion === documents.termsVersion && acceptance.privacyVersion === documents.privacyVersion &&
    acceptance.termsUrl === documents.termsUrl && acceptance.privacyUrl === documents.privacyUrl);
}

export function currentNewsletterNoticeVersion(env: Record<string, string | undefined>): string | null {
  const value = env.GPHKM_NEWSLETTER_NOTICE_VERSION?.trim() ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value) ? value : null;
}
