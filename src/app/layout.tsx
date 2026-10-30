import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "GPHKM | Guest placement workspace",
  description: "A clear workspace for guest placement orders and publication progress.",
};

export const viewport: Viewport = {
  themeColor: "#010102",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
