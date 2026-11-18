import Link from "next/link";
import { notFound } from "next/navigation";

export function LocalLegalPlaceholder({ title }: { title: "Terms of Service" | "Privacy Policy" }) {
  if (process.env.NODE_ENV !== "development") notFound();

  return (
    <main className="legalDocument">
      <p>GPHKM · Local development</p>
      <h1>{title} — local test placeholder</h1>
      <p>This page exists only to exercise the local consent flow. It is not GPHKM’s approved {title} and has no legal effect.</p>
      <p>Do not use this placeholder for public signup, orders, or real-money transactions. Replace it with approved text and publish an immutable version before launch.</p>
      <Link href="/sign-in">Return to sign in</Link>
    </main>
  );
}
