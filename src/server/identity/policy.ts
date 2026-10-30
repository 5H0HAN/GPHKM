export type OrganizationRole = "OWNER" | "MEMBER";
export type StaffRole = "ADMIN" | "FINANCE" | "SUPER_ADMIN";

export type StaffPermission =
  | "catalog.manage"
  | "supplier.manage"
  | "metrics.refresh"
  | "metrics.approve"
  | "fulfillment.manage"
  | "fulfillment.assigned.read"
  | "costs.read"
  | "supplier-payment.record"
  | "wallet.reconcile"
  | "refund.pre-handoff.approve"
  | "refund.exception.approve"
  | "access-policy.manage"
  | "supplier-report.export"
  | "staff.manage"
  | "organization.closure.manage"
  | "audit.read";

const grants: Record<StaffRole, readonly StaffPermission[]> = {
  ADMIN: [
    "catalog.manage",
    "supplier.manage",
    "metrics.refresh",
    "fulfillment.manage",
    "fulfillment.assigned.read",
    "refund.pre-handoff.approve",
    "organization.closure.manage",
    "audit.read",
  ],
  FINANCE: [
    "costs.read",
    "supplier-payment.record",
    "wallet.reconcile",
    "refund.exception.approve",
    "audit.read",
  ],
  SUPER_ADMIN: [
    "catalog.manage",
    "supplier.manage",
    "metrics.refresh",
    "metrics.approve",
    "fulfillment.manage",
    "fulfillment.assigned.read",
    "costs.read",
    "supplier-payment.record",
    "wallet.reconcile",
    "refund.pre-handoff.approve",
    "refund.exception.approve",
    "access-policy.manage",
    "supplier-report.export",
    "staff.manage",
    "organization.closure.manage",
    "audit.read",
  ],
};

export function hasStaffPermission(role: StaffRole, permission: StaffPermission): boolean {
  return grants[role].includes(permission);
}

export function assertStaffPermission(role: StaffRole, permission: StaffPermission): void {
  if (!hasStaffPermission(role, permission)) throw new Error("Forbidden");
}

export function assertOrganizationRole(actual: OrganizationRole, allowed: readonly OrganizationRole[]): void {
  if (!allowed.includes(actual)) throw new Error("Forbidden");
}

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Invalid email");
  return normalized;
}

export function normalizeDisplayName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Display name must be 1–100 safe characters");
  }
  return name;
}

export function normalizeVerifiedEmail(email: string, emailVerified: boolean): string {
  if (!emailVerified) throw new Error("Verified email required");
  return normalizeEmail(email);
}

export type Invitation = {
  email: string;
  status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  expiresAt: Date;
};

export function canAcceptInvitation(invite: Invitation, userEmail: string, emailVerified: boolean, now = new Date()): boolean {
  if (invite.status !== "PENDING" || invite.expiresAt.getTime() <= now.getTime() || !emailVerified) return false;
  return invite.email.trim().toLowerCase() === userEmail.trim().toLowerCase();
}

export function assertCanAcceptInvitation(invite: Invitation, userEmail: string, emailVerified: boolean, now = new Date()): void {
  if (!canAcceptInvitation(invite, userEmail, emailVerified, now)) throw new Error("Invitation unavailable");
}

export function assertOwnerMayLeaveOrBeRemoved(activeOwnerCount: number, targetIsOwner: boolean, ownershipTransferred: boolean): void {
  if (targetIsOwner && activeOwnerCount <= 1 && !ownershipTransferred) throw new Error("Last organization owner must transfer ownership first");
}

export function assertStaffMayBeActivated(role: StaffRole, active: boolean, mfaEnabled: boolean): void {
  if (active && !mfaEnabled) throw new Error("Staff MFA enrollment required before activation");
  if (role !== "ADMIN" && role !== "FINANCE" && role !== "SUPER_ADMIN") throw new Error("Invalid staff role");
}
