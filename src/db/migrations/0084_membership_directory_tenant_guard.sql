-- Do not let an arbitrary organization context expose another tenant's member
-- directory. Self-membership rows remain readable for account management.
DROP POLICY organization_member_read_self_or_tenant ON public.organization_member;
CREATE POLICY organization_member_read_self_or_tenant ON public.organization_member FOR SELECT TO gphkm_runtime
  USING (user_id = nullif(current_setting('app.user_id', true), '')
    OR (organization_id = nullif(current_setting('app.organization_id', true), '')
      AND public.gphkm_is_active_org_member(organization_id, nullif(current_setting('app.user_id', true), ''))));
