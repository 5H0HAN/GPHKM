export function buildContentSecurityPolicy(nonce: string, options: { development: boolean; customerSurface: boolean }): string {
  if (!/^[A-Za-z0-9+/=]{16,128}$/.test(nonce)) throw new Error("Invalid CSP nonce");
  const stripeScript = options.customerSurface ? " https://js.stripe.com" : "";
  const stripeFrames = options.customerSurface ? " https://js.stripe.com https://hooks.stripe.com https://*.stripe.com" : "";
  const stripeConnections = options.customerSurface
    ? " https://api.stripe.com https://r.stripe.com https://q.stripe.com https://m.stripe.network https://*.stripe.com https://*.stripe.network"
    : "";
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ""}${stripeScript}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `connect-src 'self'${stripeConnections}`,
    `frame-src 'self'${stripeFrames}`,
    `img-src 'self' data: blob:${options.customerSurface ? " https://*.stripe.com https://*.stripe.network" : ""}`,
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self'${options.customerSurface ? " https://checkout.stripe.com" : ""}`,
    "frame-ancestors 'none'",
    ...(options.development ? [] : ["upgrade-insecure-requests"]),
  ];
  return directives.join("; ");
}
