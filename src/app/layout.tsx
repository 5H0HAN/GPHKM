import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GPHKM | Guest placement workspace",
  description: "A clear workspace for guest placement orders and publication progress.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
