import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default function LocalTermsPlaceholder() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <main className="legalDocument">
    <h1>Local test Terms placeholder</h1>
    <p>This page exists only to exercise the local consent flow. It is not GPHKM’s Terms of Service and has no legal effect.</p>
    <p>Do not use these placeholder documents for public signup, orders, or real-money transactions. Replace the local version and URL with approved documents before launch.</p>
  </main>;
}
