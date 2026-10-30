-- Custom SQL migration file, put your code below! --
CREATE OR REPLACE FUNCTION public.gphkm_finalize_organization_closure(target_request text, target_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org_id text; current_state text;
BEGIN
 SELECT organization_id,state INTO org_id,current_state FROM public.organization_closure_request WHERE id=target_request FOR UPDATE;
 IF org_id IS NULL OR current_state NOT IN ('OPEN','INVESTIGATING','WAITING_ON_CUSTOMER')
   OR target_actor IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')
   OR NOT (public.gphkm_is_active_staff(target_actor,'ADMIN') OR public.gphkm_is_active_staff(target_actor,'SUPER_ADMIN')) THEN
   RAISE EXCEPTION 'closure request unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.organization WHERE id=org_id FOR UPDATE;
 IF cardinality(public.gphkm_closure_blockers(org_id))>0 THEN RAISE EXCEPTION 'organization closure blockers remain' USING ERRCODE='23514'; END IF;
 UPDATE public.organization SET closed_at=clock_timestamp() WHERE id=org_id AND closed_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'organization already closed' USING ERRCODE='23514'; END IF;
 UPDATE public.organization_member SET active=false WHERE organization_id=org_id AND active;
 UPDATE public.organization_invitation SET status='REVOKED',revoked_at=clock_timestamp()
   WHERE organization_id=org_id AND status='PENDING';
END $$;
