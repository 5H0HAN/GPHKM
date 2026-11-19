import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { stagingTesterEmails, stagingTesterVersions } from "@/modules/legal/staging-testers";
import { LegalDocument } from "../../legal-document";
import { testerNotices } from "../documents";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ version: string }> };

async function getVersion({ params }: Props) {
  const { version } = await params;
  if (!stagingTesterEmails(process.env) ||
    (version !== stagingTesterVersions.terms && version !== stagingTesterVersions.privacy)) notFound();
  return version;
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { title } = testerNotices[await getVersion(props)];
  return { title: `${title} | GPHKM`, robots: { index: false, follow: false } };
}

export default async function TesterNoticePage(props: Props) {
  const version = await getVersion(props);
  const related = version === stagingTesterVersions.terms ? stagingTesterVersions.privacy : stagingTesterVersions.terms;
  return <LegalDocument document={testerNotices[version]} version={version} status="For invited Google testers"
    relatedHref={`/legal/testing/${related}`} relatedTitle={testerNotices[related].title} />;
}
