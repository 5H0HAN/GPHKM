import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { currentLegalDocuments, usesStagingReviewNotices } from "@/modules/legal/policy";
import { LegalDocument } from "../../legal-document";
import { stagingReviewDrafts } from "../../drafts/documents";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Terms of Service · Staging review | GPHKM", robots: { index: false, follow: false } };

export default function StagingReviewTermsPage() {
  let active = false;
  try { active = usesStagingReviewNotices(currentLegalDocuments(process.env)); } catch { /* Keep review documents closed by default. */ }
  if (!active || process.env.GPHKM_DEPLOYMENT_ENV !== "staging") notFound();
  return <LegalDocument document={stagingReviewDrafts.terms} status="Staging review draft · Not approved for production"
    relatedHref="/legal/staging/privacy" relatedTitle="Privacy Policy" />;
}
