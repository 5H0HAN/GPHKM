import { sql } from "drizzle-orm";

export const MAX_WORKSPACE_ACCESS_ORGANIZATIONS = 100;

export function workspaceMarketplaceAccessQuery(organizationIds: readonly string[]) {
  const ids = sql.param(organizationIds.slice(0, MAX_WORKSPACE_ACCESS_ORGANIZATIONS));
  // This transaction only reads the workspace banner. Each call uses the
  // existing tenant-scoped projection, which independently checks membership.
  return sql`
    select org.id as organization_id, org.created_at,
      public.gphkm_customer_has_marketplace_access(
        set_config('app.organization_id', org.id, true)
      ) as paid_access_active
    from public.organization org
    join public.organization_member member on member.organization_id = org.id
    where member.user_id = nullif(current_setting('app.user_id', true), '')
      and member.active and org.id = any(${ids}::text[])
    order by array_position(${ids}::text[], org.id)
  `;
}
