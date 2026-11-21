import Link from "next/link";
import styles from "./drafts/draft.module.css";

type Document = {
  title: string;
  introduction: string;
  sections: ReadonlyArray<{ heading: string; text: string }>;
};

export function LegalDocument({ document, version, status, relatedHref, relatedTitle }: {
  document: Document; version?: string; status: string; relatedHref: string; relatedTitle: string;
}) {
  return (
    <main className={`legalDocument ${styles.document}`}>
      <header>
        <p className={styles.status}>{status}</p>
        <h1>{document.title}</h1>
        {version ? <p className={styles.version}>GPHKM staging · Version {version}</p> : null}
        <p className={styles.introduction}>{document.introduction}</p>
      </header>
      {document.sections.map(({ heading, text }) => (
        <section key={heading}>
          <h2>{heading}</h2>
          <p>{text}</p>
        </section>
      ))}
      <nav aria-label="Related pages">
        <Link href={relatedHref}>{relatedTitle}</Link>
        <Link href="/sign-in">Customer sign in</Link>
      </nav>
    </main>
  );
}
