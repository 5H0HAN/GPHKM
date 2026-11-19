import { stagingTesterEmails, stagingTesterVersions } from "./staging-testers.ts";

export type LegalDocuments = {
  termsVersion: string;
  privacyVersion: string;
  termsUrl: string;
  privacyUrl: string;
};
export type LegalAcceptanceInput = { accepted: unknown; termsVersion: unknown; privacyVersion: unknown };

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
  if (testerFlag && testerFlag !== "false") {
    if (!stagingTesterEmails(env)) throw new LegalConfigurationError();
    const { terms, privacy } = stagingTesterVersions;
    const origin = env.CUSTOMER_APP_URL;
    return {
      termsVersion: terms, privacyVersion: privacy,
      termsUrl: new URL(`/legal/testing/${terms}`, origin).href,
      privacyUrl: new URL(`/legal/testing/${privacy}`, origin).href,
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
