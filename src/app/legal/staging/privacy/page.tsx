import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { currentLegalDocuments, usesStagingReviewNotices } from "@/modules/legal/policy";
import { LegalDocument } from "../../legal-document";
import { stagingReviewDrafts } from "../../drafts/documents";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Privacy Policy · Staging review | GPHKM", robots: { index: false, follow: false } };

export default function StagingReviewPrivacyPage() {
  let active = false;
  try { active = usesStagingReviewNotices(currentLegalDocuments(process.env)); } catch { /* Keep review documents closed by default. */ }
  if (!active || process.env.GPHKM_DEPLOYMENT_ENV !== "staging") notFound();
  return <LegalDocument document={stagingReviewDrafts.privacy} status="Staging review draft · Not approved for production"
    relatedHref="/legal/staging/terms" relatedTitle="Terms of Service" />;
}
