import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.GPHKM_STANDALONE_BUILD === "true" ? {
    output: "standalone",
    // Each container build starts from a fresh filesystem.
    experimental: { turbopackFileSystemCacheForBuild: false },
  } : {}),
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
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      ...["/invitations/accept", "/staff/invitations/accept", "/sign-in/confirm-email", "/staff/sign-in/confirm-email"].map((source) => ({
        source,
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      })),
      ...["/sign-in/reset-password", "/staff/sign-in/reset-password"].map((source) => ({
        source,
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      })),
    ];
  },
};

export default nextConfig;
