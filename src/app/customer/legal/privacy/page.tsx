import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default function LocalPrivacyPlaceholder() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <main className="legalDocument">
    <h1>Local test Privacy placeholder</h1>
    <p>This page exists only to exercise the local consent flow. It is not GPHKM’s Privacy Policy and has no legal effect.</p>
    <p>Do not use these placeholder documents for public signup, orders, or real-money transactions. Replace the local version and URL with approved documents before launch.</p>
  </main>;
}
