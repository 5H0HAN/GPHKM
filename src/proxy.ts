import { NextResponse, type NextRequest } from "next/server";
import { authSurfaceForHost, authSurfaceOrigins } from "@/server/auth/surfaces";
import { buildContentSecurityPolicy } from "@/modules/security/content-security-policy";

function pageResponse(request: NextRequest, surface: "customer" | "staff", destination?: URL) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = buildContentSecurityPolicy(nonce, {
    development: process.env.NODE_ENV === "development",
    customerSurface: surface === "customer",
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = destination
    ? NextResponse.rewrite(destination, { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

/**
 * Map configured customer/staff hosts into isolated route trees. This is a
 * presentation boundary only; protected pages and commands still authorize
 * from the verified session and current database permissions.
 */
export function proxy(request: NextRequest) {
  let origins: { customer: string; staff: string };
  try {
    origins = authSurfaceOrigins(process.env);
  } catch {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse("Application host configuration is unavailable", { status: 503 });
    }
    const path = request.nextUrl.pathname;
    if (path === "/" || path.startsWith("/api/") || path.startsWith("/_next/") || path === "/favicon.ico") {
      return NextResponse.next();
    }
    return new NextResponse("Customer and staff hostnames are not configured", { status: 404 });
  }

  const host = request.headers.get("host");
  const surface = host ? authSurfaceForHost(host, origins) : null;
  if (!surface) {
    if (process.env.NODE_ENV === "production") return new NextResponse("Not found", { status: 404 });

    const pathname = request.nextUrl.pathname;
    if (pathname.startsWith("/api/") || pathname.startsWith("/_next/") || pathname === "/favicon.ico") {
      return NextResponse.next();
    }
    if (pathname === "/") return pageResponse(request, "customer");

    const destination = pathname.startsWith("/staff")
      ? origins.staff
      : pathname.startsWith("/customer") || pathname.startsWith("/sign-in") || pathname.startsWith("/invitations/")
        ? origins.customer
        : null;
    if (!destination) return NextResponse.redirect(new URL("/", request.nextUrl));

    const target = new URL(`${pathname}${request.nextUrl.search}`, destination);
    return NextResponse.redirect(target);
  }

  const pathname = request.nextUrl.pathname;
  if (pathname.startsWith("/api/") || pathname.startsWith("/_next/") || pathname === "/favicon.ico") {
    return NextResponse.next();
  }

  if (surface === "customer") {
    if (pathname.startsWith("/sign-in") || pathname === "/invitations/accept" || pathname.startsWith("/customer")) return pageResponse(request, surface);
    const target = request.nextUrl.clone();
    target.pathname = pathname === "/" ? "/customer" : `/customer${pathname}`;
    return pageResponse(request, surface, target);
  }

  if (pathname === "/sign-in") {
    const target = request.nextUrl.clone();
    target.pathname = "/staff/sign-in";
    return pageResponse(request, surface, target);
  }
  if (pathname.startsWith("/staff")) return pageResponse(request, surface);
  const target = request.nextUrl.clone();
  target.pathname = pathname === "/" ? "/staff" : `/staff${pathname}`;
  return pageResponse(request, surface, target);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
