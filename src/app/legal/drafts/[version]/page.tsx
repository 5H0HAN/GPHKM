import type { Metadata } from "next";
import { LegalDocument } from "../../legal-document";
import { notFound } from "next/navigation";
import { stagingDrafts, stagingDraftVersion } from "../documents";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ version: string }> };

async function getVersion({ params }: Props) {
  const version = stagingDraftVersion(process.env.GPHKM_DEPLOYMENT_ENV, (await params).version);
  if (!version) notFound();
  return version;
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { title } = stagingDrafts[await getVersion(props)];
  return { title: `${title} · Staging draft | GPHKM`, robots: { index: false, follow: false } };
}

export default async function LegalDraftPage(props: Props) {
  const version = await getVersion(props);
  const related = version === "terms-2026-11-19-v1" ? "privacy-2026-11-19-v1" : "terms-2026-11-19-v1";
  return <LegalDocument document={stagingDrafts[version]} version={version} status="Preliminary draft for review"
    relatedHref={`/legal/drafts/${related}`} relatedTitle={`${stagingDrafts[related].title} draft`} />;
}
