import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { appendAuditEvent, type DbTransaction } from "@/server/audit/append";
import { requireStaffAccess, type StaffActor } from "@/server/auth/staff";
import { staffCustomerDirectoryPagination } from "@/modules/identity/customer-directory-pagination";

const CUSTOMER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ACCOUNT_REASONS = ["CUSTOMER_REQUEST", "POLICY_REVIEW", "SECURITY_REVIEW", "OTHER_OPERATIONAL"] as const;
const MEMBERSHIP_REASONS = ["CUSTOMER_REQUEST", "SUPPORT_REVIEW", "SECURITY_REVIEW", "CORRECTION"] as const;
const CUSTOMER_STATES = ["ALL", "ACTIVE", "SUSPENDED"] as const;
type CustomerAccountState = "ACTIVE" | "SUSPENDED";
type OrganizationRole = "OWNER" | "MEMBER";

function validCustomerId(value: string) {
  if (!CUSTOMER_ID.test(value)) throw new Error("Customer record unavailable");
  return value;
}

function validSearch(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (normalized.length > 100) throw new Error("Search is limited to 100 characters");
  return normalized;
}

async function staffTx<T>(headers: Headers, permission: "customer.directory.read" | "customer.account.manage", work: (tx: DbTransaction, actor: StaffActor) => Promise<T>) {
  const actor = await requireStaffAccess(headers, permission);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    return work(tx, actor);
  });
}

export type StaffCustomerRow = {
  customer_id: string;
  customer_name: string;
  customer_email: string;
  email_verified: boolean;
  joined_at: Date;
  account_state: CustomerAccountState;
  organization_count: number;
  active_organization_count: number;
  paid_order_count: number;
  open_support_count: number;
};

export type StaffCustomerDetail = {
  customer: {
    id: string; name: string; email: string; emailVerified: boolean; joinedAt: string;
    accountState: CustomerAccountState; reasonCode: string | null; changedAt: string | null;
  };
  walletBalances: Array<{
    organizationId: string; organizationName: string; balanceMinor: string; currency: "USD";
  }>;
  memberships: Array<{
    id: string; organizationId: string; organizationName: string; role: OrganizationRole;
    active: boolean; joinedAt: string; closedAt: string | null;
  }>;
  orders: Array<{ id: string; createdAt: string; status: string; itemCount: number }>;
  supportCases: Array<{ id: string; summary: string; state: string; updatedAt: string }>;
  closureRequests: Array<{
    id: string; organizationName: string; summary: string; state: string; updatedAt: string;
  }>;
};

export async function listStaffCustomers(headers: Headers, requestedPage: unknown, rawSearch: unknown, rawState: unknown) {
  const search = validSearch(rawSearch);
  const state = typeof rawState === "string" && (CUSTOMER_STATES as readonly string[]).includes(rawState) ? rawState : "ALL";
  return staffTx(headers, "customer.directory.read", async (tx, actor) => {
    const countResult = await tx.execute(sql`select public.gphkm_staff_customer_search_count(${search}, ${state}) as total`);
    const total = (countResult as unknown as { rows?: Array<{ total: number }> }).rows?.[0]?.total ?? 0;
    const pagination = staffCustomerDirectoryPagination(requestedPage, Number(total));
    const result = await tx.execute(sql`
      select * from public.gphkm_staff_customer_search(${search}, ${state}, ${pagination.limit}, ${pagination.offset})
    `);
    const rows = (result as unknown as { rows?: StaffCustomerRow[] }).rows ?? [];
    await appendAuditEvent(tx, {
      actorUserId: actor.userId, action: "customer.directory_viewed", targetType: "CUSTOMER_DIRECTORY",
      targetId: "LIST", metadata: { result: "ALLOWED" },
    });
    return { rows, pagination, search, state };
  });
}

export async function getStaffCustomer(headers: Headers, rawCustomerId: string): Promise<StaffCustomerDetail | null> {
  const customerId = validCustomerId(rawCustomerId);
  return staffTx(headers, "customer.directory.read", async (tx, actor) => {
    const result = await tx.execute(sql`select public.gphkm_staff_customer_detail(${customerId}) as detail`);
    const detail = (result as unknown as { rows?: Array<{ detail: StaffCustomerDetail | null }> }).rows?.[0]?.detail ?? null;
    if (!detail) return null;
    const walletResult = await tx.execute(sql`
      select public.gphkm_staff_customer_wallet_balance_projection(${customerId}) as balances
    `);
    const walletBalances = (walletResult as unknown as {
      rows?: Array<{ balances: StaffCustomerDetail["walletBalances"] }>;
    }).rows?.[0]?.balances ?? [];
    await appendAuditEvent(tx, {
      actorUserId: actor.userId, action: "customer.account_viewed", targetType: "CUSTOMER_ACCOUNT",
      targetId: customerId, metadata: { result: "ALLOWED" },
    });
    await appendAuditEvent(tx, {
      actorUserId: actor.userId, action: "customer.wallet_balance_viewed", targetType: "CUSTOMER_WALLET_PROJECTION",
      targetId: customerId, metadata: { result: "ALLOWED" },
    });
    return { ...detail, walletBalances };
  });
}

export async function setStaffCustomerAccountState(
  headers: Headers,
  input: { customerId: string; expectedState: CustomerAccountState; state: CustomerAccountState; reason: string },
) {
  const customerId = validCustomerId(input.customerId);
  if (!(ACCOUNT_REASONS as readonly string[]).includes(input.reason)) throw new Error("Invalid customer account reason");
  if (!( ["ACTIVE", "SUSPENDED"] as const).includes(input.state) || !( ["ACTIVE", "SUSPENDED"] as const).includes(input.expectedState)) {
    throw new Error("Invalid customer account state");
  }
  return staffTx(headers, "customer.account.manage", async (tx) => {
    const result = await tx.execute(sql`
      select public.gphkm_staff_set_customer_account_state(${customerId}, ${input.expectedState}, ${input.state}, ${input.reason}) as changed
    `);
    return (result as unknown as { rows?: Array<{ changed: boolean }> }).rows?.[0]?.changed === true;
  });
}

export async function updateStaffCustomerMembership(
  headers: Headers,
  input: {
    customerId: string; organizationId: string; expectedRole: OrganizationRole; expectedActive: boolean;
    role: OrganizationRole; active: boolean; reason: string;
  },
) {
  const customerId = validCustomerId(input.customerId);
  const organizationId = validCustomerId(input.organizationId);
  if (!(MEMBERSHIP_REASONS as readonly string[]).includes(input.reason)) throw new Error("Invalid membership reason");
  if (!( ["OWNER", "MEMBER"] as const).includes(input.role) || !( ["OWNER", "MEMBER"] as const).includes(input.expectedRole)) {
    throw new Error("Invalid organization role");
  }
  if (typeof input.active !== "boolean" || typeof input.expectedActive !== "boolean") throw new Error("Invalid membership state");
  return staffTx(headers, "customer.account.manage", async (tx) => {
    const result = await tx.execute(sql`
      select public.gphkm_staff_update_customer_membership(
        ${organizationId}, ${customerId}, ${input.expectedRole}, ${input.expectedActive},
        ${input.role}, ${input.active}, ${input.reason}
      ) as changed
    `);
    return (result as unknown as { rows?: Array<{ changed: boolean }> }).rows?.[0]?.changed === true;
  });
}
