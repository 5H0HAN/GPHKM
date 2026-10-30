export const ACTIVE_ORGANIZATION_COOKIE = "gphkm-active-organization";

export function chooseOrganizationId(organizations: readonly { id: string }[], requested?: string | null): string | null {
  return organizations.some((organization) => organization.id === requested) ? requested ?? null : organizations[0]?.id ?? null;
}

export function preferOrganization<T extends { id: string }>(organizations: readonly T[], preferred?: string | null): T[] {
  const selected = organizations.find((organization) => organization.id === preferred);
  return selected ? [selected, ...organizations.filter((organization) => organization.id !== selected.id)] : [...organizations];
}

export function normalizeOrganizationName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Organization name must be 2–120 safe characters");
  return name;
}

export function organizationPath(pathname: string, organizationId: string): string {
  // Detail routes contain records from the previous organization. Return to the
  // section instead of carrying those IDs into another organization's view.
  const path = /^\/customer\/support\/[^/]+/.test(pathname) ? "/customer/support" : pathname;
  return `${path.startsWith("/customer") ? path : "/customer"}?organizationId=${encodeURIComponent(organizationId)}`;
}

export function invitationDisplayStatus(status: string, expiresAt: Date, now = new Date()) {
  return status === "PENDING" && expiresAt.getTime() <= now.getTime() ? "EXPIRED" : status;
}

export function organizationInvitationDeliveryStatus(env: Record<string, string | undefined> = process.env) {
  const configured = env.GPHKM_RESEND_DATA_HANDLING_APPROVED === "true"
    && Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL && env.RESEND_WEBHOOK_ID && env.RESEND_WEBHOOK_SECRET)
    && Boolean(env.GPHKM_PUBLIC_BASE_URL && env.CUSTOMER_APP_URL && env.STAFF_APP_URL)
    && /^[a-fA-F0-9]{64}$/.test(env.GPHKM_INVITATION_TOKEN_ENCRYPTION_KEY ?? "");
  return configured
    ? { available: true as const, message: "Invitation email is queued for secure delivery." }
    : { available: false as const, message: "Invitation email is unavailable until the sender, webhook, encryption key, and data-handling approval are configured." };
}

export function assertOrganizationInvitationDeliveryAvailable(env: Record<string, string | undefined> = process.env): void {
  if (!organizationInvitationDeliveryStatus(env).available) throw new Error("Secure invitation email delivery is unavailable");
}
