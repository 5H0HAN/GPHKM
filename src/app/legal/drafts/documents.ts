// Keep a reviewed version immutable. Publish changed wording under a new key and URL.
export const stagingDrafts = {
  "terms-2026-11-19-v1": {
    title: "Terms of Service",
    introduction: "GPHKM staging lets your team try a guest-post order with fictional publications and test funds. This draft describes that exercise. It awaits owner and legal review and has no effective date.",
    sections: [
      {
        heading: "Using the test workspace",
        text: "Use the staging account assigned to you. Enter fictional organizations, billing addresses, briefs, articles and support requests. Keep credentials private. If Google sign-in is available, use the designated test account. Ask the person who invited you before bringing anyone else into the workspace.",
      },
      {
        heading: "Catalog access and orders",
        text: "A new organization can browse for 15 days. Under the initial policy, one settled test top-up of at least $50 unlocks browsing and eligible website addresses for six calendar months. Spending the balance does not shorten that period. An order can contain up to 25 different listings. Each placement keeps the retail price shown at checkout and has its own progress record.",
      },
      {
        heading: "Test funds and refunds",
        text: "Owners fund the shared USD wallet. Members can spend its available balance on organization orders. If Stripe testing is enabled, use Stripe test payment details only. Test balances have no cash value. The wallet model has no balance expiry or voluntary cash-out. An eligible cancellation credits the organization wallet. Ordinary cancellation ends when the publication handoff occurs or internal work starts. Later exceptions require a reviewed Support case.",
      },
      {
        heading: "Articles, writing and sharing",
        text: "Supply a fictional article you have permission to use, or select GPHKM Writing where offered. A writing add-on shows its price, delivery estimate, draft stages and refund terms before checkout. It includes one revision. Only undelivered writing stages are eligible for a writing credit. A placement can continue with a customer article if a final writing draft is declined.",
      },
      {
        heading: "What can be submitted",
        text: "Provide only material you have the right to share with the publication site or partner. Review the listing rules and the content-sharing notice before authorizing a handoff. Do not submit unlawful, abusive or unlicensed content, phishing links, malware or private client information. Staff can hold or reject material that conflicts with the content rules. Staging uses synthetic recipients and external email delivery is disabled.",
      },
      {
        heading: "Publication and support",
        text: "Demo milestones simulate editorial review and publication. They do not promise a live article, search indexing, traffic or a ranking. In the placement model, a lifetime term expresses the publisher’s intent. If a link disappears after verified completion, that alone does not create a refund or replacement entitlement. Use in-app Support for test-order questions or to request organization closure. If you cannot sign in, contact the person who invited you.",
      },
      {
        heading: "Before public release",
        text: "The contracting entity, eligibility rules, governing law, dispute procedure, formal support contact, and any legally required payment exceptions are still under review. Approved terms will have their own version and effective date. Opening this review copy records no acceptance.",
      },
    ],
  },
  "privacy-2026-11-19-v1": {
    title: "Privacy Policy",
    introduction: "This draft explains how information moves through the GPHKM staging workspace. It awaits owner and privacy review and has no effective date. Use fictional business records and test content. Account and connection details can still identify a tester.",
    sections: [
      {
        heading: "Accounts and sign-in",
        text: "GPHKM uses your account identifier, display name, email address, verification status and organization role to sign you in and control access. Where enabled, Google sign-in requests identity, email and basic profile information. Google handles your Google password. For a password-based GPHKM account, the application stores a password hash. Authenticator enrollment and backup-code records support account security and recovery.",
      },
      {
        heading: "Cookies and security records",
        text: "Session cookies keep you signed in on the relevant host. Customer and staff sessions are separate. The service can process an IP address, browser information, access times, and session and rate-limit records to authenticate requests and investigate misuse. Audit records identify the actor, time and affected record for sensitive changes.",
      },
      {
        heading: "Organization, orders and support",
        text: "The workspace stores organization membership and any optional legal name, billing email or billing address entered by an Owner. Use fictional billing details. Order records include selections, text articles, briefs, instructions, approvals and progress. Support stores messages and their status. Owners can see organization orders. Members see their own orders. Staff access depends on their role and the work assigned to them.",
      },
      {
        heading: "Service providers and recipients",
        text: "The application host and database process the records needed to run staging. If you use Google sign-in, Google handles the authentication request. If Stripe testing is enabled, Stripe processes the simulated checkout. GPHKM records the amount, currency, provider references and outcome to reconcile the test wallet. Never enter a real card. External email delivery through Resend is disabled for this staging environment.",
      },
      {
        heading: "Sharing publication content",
        text: "The placement workflow prepares approved article text and instructions for the publication site or partner selected for that item. The authorizing tester can review the sharing notice before checkout and may need to approve changes later. Use synthetic text even when rehearsing a manual handoff. Keep personal data and confidential client work out of test packets.",
      },
      {
        heading: "Access, correction and closure",
        text: "You can review account and security settings, revoke sessions and view any recorded document acceptances. An Owner can update the organization’s billing profile and request closure through Support. For a privacy question, correction or deletion request, use in-app Support or contact the person who invited you. Include the account or test-record reference and keep sensitive content out of the request.",
      },
      {
        heading: "Retention and pending review",
        text: "Closure removes organization access once outstanding orders, funds and cases are resolved. Financial entries, security audits and order evidence serve reconciliation and investigation purposes. Closing a workspace does not erase every record. The operator’s legal identity and privacy contact, processing locations and transfers, applicable rights and legal bases, and retention periods for records and backups require review before public release.",
      },
    ],
  },
} as const;

export type StagingDraftVersion = keyof typeof stagingDrafts;

export function stagingDraftVersion(environment: string | undefined, version: string): StagingDraftVersion | null {
  return environment === "staging" && Object.hasOwn(stagingDrafts, version) ? version as StagingDraftVersion : null;
}
