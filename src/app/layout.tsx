import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "GPHKM | Guest placements, clearly managed",
  description: "Find guest placement opportunities and follow every order through publication updates.",
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
