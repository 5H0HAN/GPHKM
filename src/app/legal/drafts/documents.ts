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

export const stagingReviewDrafts = {
  terms: {
    title: "Terms of Service",
    introduction: "This is a review draft for the GPHKM staging service. It is not approved for production or for accepting real money. Use fictional business details, synthetic content and payment-provider test details only. The business identity, applicable law, dispute terms and required consumer protections still need review.",
    sections: [
      { heading: "Accounts and organizations", text: "Customers may create an account with a verified email address and password or use Google sign-in where available. The first customer who creates an organization becomes its Owner. Owners manage organization settings, members and funding. Members can place orders and view their own order activity. Keep your sign-in details private and tell us through in-app Support if you think someone has accessed your account." },
      { heading: "What GPHKM provides", text: "GPHKM offers guest-post placement listings and related order coordination. Listing details, price, publication term, writing options and requirements are shown before an order is submitted. A publisher's stated lifetime placement term describes that publisher's intention; it is not a guarantee that a link will remain available forever. GPHKM does not promise search indexing, traffic, rankings or a particular marketing result." },
      { heading: "Organization wallet and payments", text: "The product uses a shared USD wallet for an organization. Owners manage wallet funding; available balance is used for orders. Wallet balances do not expire under the current product rules and there is no voluntary cash-out feature. Eligible order credits are returned to the organization wallet. A qualifying settled top-up may grant catalog access under the policy shown in the product. This staging service uses sandbox payments only; staging balances have no cash value. Never enter a real card or payment credential." },
      { heading: "Orders, cancellation and fulfillment", text: "Order prices and selected options are recorded when checkout is completed. You may provide article text you have permission to use or choose an available GPHKM Writing option, whose price, delivery estimate, draft stages and included revision are shown before purchase. Cancellation eligibility depends on the order's progress and the policy displayed in the app. After supplier handoff or internal work begins, ordinary cancellation is generally unavailable; use in-app Support to request review of an exceptional issue. Any approved credit follows the product's stated wallet and writing-stage rules." },
      { heading: "Content and publication partners", text: "You keep ownership of content you submit. You authorize GPHKM to use and share the selected article, brief and instructions as needed to review and arrange the placement you request, including with the relevant publication site or partner. Confirm that you have the rights and permissions needed for that sharing. Do not submit unlawful, abusive, confidential, unlicensed, phishing or malicious material. Suppliers and sourcing classifications are internal and are not part of the customer catalog." },
      { heading: "Account safety and service controls", text: "GPHKM may review, hold or restrict an account, listing or order when needed to protect the service, investigate suspected misuse or comply with a valid legal requirement. Staff actions are limited by role and audited. Do not attempt to bypass access controls, interfere with the service or use it to distribute malware, spam or deceptive content." },
      { heading: "Messages and support", text: "GPHKM sends transactional messages about account verification, password resets, invitations and service activity. Newsletter messages are separate and require a separate preference. Use the in-app Support area for help, privacy questions or organization-closure requests. Email replies about a Support case may come from the GPHKM support address." },
      { heading: "Review status", text: "This draft does not identify the final contracting entity, governing law, dispute process, service commitments or all legally required payment and consumer rights. Those items require owner and qualified legal review before production. Staging acceptance records which review notice you accepted so the test flow can be exercised; that staging record is not approval for production use." },
    ],
  },
  privacy: {
    title: "Privacy Policy",
    introduction: "This is a review draft describing personal information used by GPHKM. It is prepared for the staging service and is not approved for production. The final legal entity, applicable privacy law, contact details, retention periods and processing locations require review. Use fictional organization, billing and order details during staging.",
    sections: [
      { heading: "Information used", text: "GPHKM processes account name and email, email-verification state, sign-in method, organization membership and role, and security records such as sessions, authenticator enrollment, backup codes and audit events. Owners may add an optional legal name, billing email and billing address. Orders may contain selected listings, article text, writing briefs, instructions, approvals and progress. Support requests contain the messages and case details you submit." },
      { heading: "How information is used", text: "Information is used to create and secure accounts, form organizations, provide the catalog, process wallet activity and orders, coordinate publication work, deliver Support, record required customer choices, prevent misuse and maintain financial and security records. Passwords are stored as password hashes. Google handles Google account passwords; GPHKM receives identity information needed to sign in. Session cookies keep you signed in on the customer or staff surface, with those sessions separated." },
      { heading: "Payments and service providers", text: "When sandbox checkout is enabled, Stripe handles the test payment flow. GPHKM stores transaction references, amount, currency and outcome needed to reconcile a wallet event; do not use real payment details in staging. Resend processes transactional account, invitation and Support-related email. The application host and database provider process information needed to operate the service. The final provider list, processing locations, transfer safeguards and retention terms must be confirmed before production." },
      { heading: "Sharing order information", text: "GPHKM staff can access customer information according to their role and assigned work. When you request a placement, the content and instructions you approve may be shared with the publication site or partner needed to fulfill that order. Customer views do not disclose supplier identities or internal source classifications. GPHKM does not sell customer profile or order content as part of this service model." },
      { heading: "Email choices", text: "Transactional mail includes verification, password-reset and invitation links, plus relevant order and Support updates. These messages are needed to provide requested account and service functions. Newsletter messages are optional and controlled by a separate preference. Avoid forwarding password-reset or invitation links; they grant time-limited access to an account action." },
      { heading: "Security and retention", text: "GPHKM uses access controls, encrypted transport, restricted staff roles and audit records to protect information. No online service can promise perfect security. Records are kept as needed to operate accounts and orders, provide Support, prevent abuse and reconcile financial activity. Exact retention and deletion periods, including legal and financial exceptions, remain to be approved; closing an organization does not automatically erase every related record." },
      { heading: "Your choices and requests", text: "You can manage account security, revoke sessions, update available profile or organization settings, and request organization closure through in-app Support. You may separately change your newsletter preference. Use Support to ask about access, correction or deletion of information. The final policy must explain the rights and request process that apply in the jurisdictions where GPHKM operates." },
      { heading: "Items for final review", text: "Before production, GPHKM must identify the responsible legal entity and privacy contact; confirm lawful purposes, applicable rights, processing locations and international transfers; publish the approved retention schedule; and review Google, Resend, Stripe, hosting and publication-partner disclosures. This staging draft is not a substitute for that review." },
    ],
  },
} as const;
