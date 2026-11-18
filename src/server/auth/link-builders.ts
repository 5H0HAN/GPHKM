import { authSurfaceOrigins, type AuthSurface } from "./surfaces.ts";
import { publicBaseOrigin } from "./url-policy.ts";

type Environment = Record<string, string | undefined>;

export function appUrl(env: Environment, surface: AuthSurface): URL {
  return new URL(authSurfaceOrigins(env)[surface]);
}
export function customerUrl(env: Environment, path = "/"): string {
  return new URL(path, appUrl(env, "customer")).toString();
}
export function staffUrl(env: Environment, path = "/"): string {
  return new URL(path, appUrl(env, "staff")).toString();
}
export function resetPasswordPath(surface: AuthSurface): string {
  return surface === "staff" ? "/staff/sign-in/reset-password" : "/sign-in/reset-password";
}
export function resetPasswordUrl(env: Environment, surface: AuthSurface, token: string): string {
  const url = new URL(resetPasswordPath(surface), appUrl(env, surface));
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}
export function invitationUrl(env: Environment, kind: "STAFF" | "ORGANIZATION", token: string, email?: string): string {
  const url = new URL(kind === "STAFF" ? "/staff/invitations/accept" : "/invitations/accept", appUrl(env, kind === "STAFF" ? "staff" : "customer"));
  const fragment = new URLSearchParams({ token });
  if (email) fragment.set("email", email);
  url.hash = fragment.toString();
  return url.toString();
}
export function resendWebhookUrl(env: Environment): string {
  const base = publicBaseOrigin(env);
  if (!base) throw new Error("GPHKM_PUBLIC_BASE_URL is required");
  return new URL("/api/webhooks/resend", base).toString();
}
