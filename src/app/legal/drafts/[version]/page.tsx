import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { stagingDrafts, stagingDraftVersion } from "../documents";
import styles from "../draft.module.css";

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
  const { title, introduction, sections } = stagingDrafts[version];
  const related = version === "terms-2026-11-19-v1" ? "privacy-2026-11-19-v1" : "terms-2026-11-19-v1";
  return (
    <main className={`legalDocument ${styles.document}`}>
      <header>
        <p className={styles.status}>Preliminary draft for review</p>
        <h1>{title}</h1>
        <p className={styles.version}>GPHKM staging · Version {version}</p>
        <p className={styles.introduction}>{introduction}</p>
      </header>
      {sections.map(({ heading, text }) => (
        <section key={heading}>
          <h2>{heading}</h2>
          <p>{text}</p>
        </section>
      ))}
      <nav aria-label="Related pages">
        <Link href={`/legal/drafts/${related}`}>{stagingDrafts[related].title} draft</Link>
        <Link href="/sign-in">Customer sign in</Link>
      </nav>
    </main>
  );
}
