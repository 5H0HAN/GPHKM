CREATE TABLE public.organization_billing_profile (
  organization_id text PRIMARY KEY REFERENCES public.organization(id),
  legal_name text,
  billing_email text,
  billing_address text,
  updated_by_user_id text NOT NULL REFERENCES public.auth_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_billing_legal_name_length CHECK (
    legal_name IS NULL OR length(btrim(legal_name)) BETWEEN 1 AND 160
  ),
  CONSTRAINT organization_billing_email_length CHECK (
    billing_email IS NULL OR length(billing_email) BETWEEN 3 AND 254
  ),
  CONSTRAINT organization_billing_address_length CHECK (
    billing_address IS NULL OR length(btrim(billing_address)) BETWEEN 1 AND 1000
  )
);--> statement-breakpoint

ALTER TABLE public.organization_billing_profile ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT ON public.organization_billing_profile TO gphkm_runtime;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.organization_billing_profile FROM gphkm_runtime;--> statement-breakpoint

CREATE POLICY organization_billing_profile_owner_read ON public.organization_billing_profile
  FOR SELECT TO gphkm_runtime USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND public.gphkm_is_active_org_owner(organization_id, nullif(current_setting('app.user_id', true), ''))
  );--> statement-breakpoint

CREATE FUNCTION public.gphkm_update_organization_billing_profile(
  target_organization_id text,
  target_legal_name text,
  target_billing_email text,
  target_billing_address text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor text := nullif(current_setting('app.user_id', true), '');
  active_org text := nullif(current_setting('app.organization_id', true), '');
  prior public.organization_billing_profile%ROWTYPE;
  has_profile boolean;
  changed_fields text[] := ARRAY[]::text[];
BEGIN
  IF actor IS NULL OR active_org IS DISTINCT FROM target_organization_id
     OR NOT public.gphkm_is_active_org_owner(target_organization_id, actor) THEN
    RAISE EXCEPTION 'active organization Owner required' USING ERRCODE = '42501';
  END IF;
  IF (target_legal_name IS NOT NULL AND (
        length(btrim(target_legal_name)) NOT BETWEEN 1 AND 160 OR target_legal_name ~ '[[:cntrl:]]'))
     OR (target_billing_email IS NOT NULL AND (
        length(target_billing_email) NOT BETWEEN 3 AND 254
        OR target_billing_email <> lower(btrim(target_billing_email))
        OR target_billing_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
     OR (target_billing_address IS NOT NULL AND (
        length(btrim(target_billing_address)) NOT BETWEEN 1 AND 1000 OR target_billing_address ~ '[[:cntrl:]]')) THEN
    RAISE EXCEPTION 'invalid organization billing profile' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.organization
   WHERE id = target_organization_id AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT public.gphkm_is_active_org_owner(target_organization_id, actor) THEN
    RAISE EXCEPTION 'organization billing profile unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO prior FROM public.organization_billing_profile
   WHERE organization_id = target_organization_id FOR UPDATE;
  has_profile := FOUND;
  IF NOT has_profile OR prior.legal_name IS DISTINCT FROM target_legal_name THEN
    changed_fields := array_append(changed_fields, 'legalName');
  END IF;
  IF NOT has_profile OR prior.billing_email IS DISTINCT FROM target_billing_email THEN
    changed_fields := array_append(changed_fields, 'billingEmail');
  END IF;
  IF NOT has_profile OR prior.billing_address IS DISTINCT FROM target_billing_address THEN
    changed_fields := array_append(changed_fields, 'billingAddress');
  END IF;
  IF cardinality(changed_fields) = 0 THEN RETURN false; END IF;

  IF has_profile THEN
    UPDATE public.organization_billing_profile
       SET legal_name = target_legal_name,
           billing_email = target_billing_email,
           billing_address = target_billing_address,
           updated_by_user_id = actor,
           updated_at = now()
     WHERE organization_id = target_organization_id;
  ELSE
    INSERT INTO public.organization_billing_profile (
      organization_id, legal_name, billing_email, billing_address, updated_by_user_id
    ) VALUES (
      target_organization_id, target_legal_name, target_billing_email, target_billing_address, actor
    );
  END IF;

  INSERT INTO public.audit_event (
    id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata, created_at
  ) VALUES (
    gen_random_uuid()::text, target_organization_id, actor, 'ORGANIZATION_BILLING_PROFILE_UPDATED',
    'ORGANIZATION_BILLING_PROFILE', target_organization_id, 'OWNER_EDIT',
    jsonb_build_object('changedFields', to_jsonb(changed_fields)), now()
  );
  RETURN true;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.gphkm_update_organization_billing_profile(text, text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_update_organization_billing_profile(text, text, text, text) TO gphkm_runtime;
