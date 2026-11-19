import { stagingTesterVersions } from "../../../modules/legal/staging-testers.ts";

// Acceptance evidence references these immutable URLs and versions. Add a new pair when wording changes.
export const testerNotices = {
  [stagingTesterVersions.terms]: {
    title: "Staging tester terms",
    introduction: "These terms cover the GPHKM guest-placement demo for invited Google testers. By selecting the acceptance checkbox, you agree to the test rules below. The public service terms are still under review.",
    sections: [
      {
        heading: "Use your invited account",
        text: "Use the Google account invited to this staging environment. Keep the session and its credentials private. Participation is limited to testing the catalog, organization workspace, and simulated order flows. Access can end when testing concludes or your account is removed from the tester list.",
      },
      {
        heading: "Enter fictional material",
        text: "Use made-up organization details, articles, links, billing profiles, and support messages. Only submit text that you have the right to use and share. Keep client information, passwords, and private or sensitive records out of the workspace. Unlawful, abusive, unlicensed, or malicious content may be held or rejected.",
      },
      {
        heading: "Try the wallet and placement workflow",
        text: "Prices and wallet balances are in test USD. If Stripe testing is available, use Stripe’s test payment details only. An Owner funds the shared test wallet, and Members can place test orders against it. Simulated refunds return eligible amounts to the organization wallet. Test credits have no cash value. An order in staging does not buy a publication, ranking, indexing outcome, or other live service.",
      },
      {
        heading: "Review before sharing",
        text: "The order flow may ask you to approve an article and instructions for a publication partner. Use fictional text and recipients, including during manual handoff exercises. External email delivery is disabled. For a problem with the demo or to request closure, use in-app Support or contact the person who invited you.",
      },
      {
        heading: "What your acceptance covers",
        text: "Your acceptance applies to this version of the tester terms and its accompanying staging privacy notice. GPHKM records your account, the versions and URLs, and the time of acceptance. Commercial terms, payment exceptions, the contracting entity and dispute arrangements remain under review for any future public service.",
      },
    ],
  },
  [stagingTesterVersions.privacy]: {
    title: "Staging tester privacy notice",
    introduction: "This notice describes how GPHKM handles information during the invited Google tester demo. You can read both notices before choosing whether to join. A privacy policy for the public service is still under review.",
    sections: [
      {
        heading: "Your Google identity",
        text: "Google authenticates you. GPHKM requests identity, email and basic profile scopes, including your account identifier, email verification status, display name and profile image where available. It uses the verified email to check the tester list and the account information to run your workspace. GPHKM does not receive your Google password.",
      },
      {
        heading: "Sessions and access records",
        text: "Host-specific session cookies maintain sign-in. The service can process an IP address, browser information, session timestamps, rate-limit information and sensitive-action audit events to protect access. GPHKM records which notice versions and URLs you accepted, when, and under which account.",
      },
      {
        heading: "Your test workspace",
        text: "The database stores membership and roles, any fictional billing profile an Owner enters, selections, orders, text articles and briefs, approval history, and messages sent to Support. Owners can see organization orders. Members see their own orders. Staff can access the information required by their assigned role and work. Hosting and database services process these records to operate staging.",
      },
      {
        heading: "Payments and publication exercises",
        text: "When sandbox funding is available, Stripe handles the simulated checkout. GPHKM stores payment and event references, amount, currency, and status for reconciliation. Never provide real card details. The placement workflow prepares approved text and instructions for a publication partner. Use synthetic recipients and content. Staging does not send external email through Resend.",
      },
      {
        heading: "Access, correction and retention",
        text: "Use account settings to review sessions and acceptance history. For a correction, deletion request or privacy question, use in-app Support or the contact who invited you. Only include the reference needed to locate the test record. Closing an organization removes organization access once outstanding work and balances are resolved. Audit, order and financial evidence can remain for security and reconciliation. Retention periods, backup schedules, processing locations, applicable rights and formal privacy contacts require review before public release.",
      },
    ],
  },
} as const;
