import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: [process.env.CUSTOMER_APP_URL, process.env.STAFF_APP_URL]
    .flatMap((value) => {
      if (!value) return [];
      try { return [new URL(value).hostname]; } catch { return []; }
    }),
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return ["/invitations/accept", "/staff/invitations/accept"].map((source) => ({
      source,
      headers: [
        { key: "Cache-Control", value: "no-store" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ],
    }));
  },
};

export default nextConfig;
