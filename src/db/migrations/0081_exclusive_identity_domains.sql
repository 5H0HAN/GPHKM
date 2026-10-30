-- A principal belongs to the customer or staff authority domain, never both.
-- Fail closed if existing data needs deliberate cleanup before this rule lands.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.organization_member om
    JOIN public.staff_account sa ON sa.user_id = om.user_id
  ) THEN
    RAISE EXCEPTION 'customer/staff identity overlap must be resolved before migration';
  END IF;
END;
$$;

CREATE FUNCTION public.gphkm_guard_exclusive_identity_domain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- Serialize first customer membership and staff-account provisioning on
  -- the principal row so two concurrent signup/invitation flows cannot race.
  PERFORM 1 FROM public.auth_user WHERE id = NEW.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'identity principal unavailable' USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'organization_member' THEN
    IF EXISTS (SELECT 1 FROM public.staff_account WHERE user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'staff identities cannot hold customer organization membership' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'staff_account' THEN
    IF EXISTS (SELECT 1 FROM public.organization_member WHERE user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'customer identities cannot be provisioned as staff' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported identity-domain target' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_guard_exclusive_identity_domain() FROM PUBLIC;

CREATE TRIGGER organization_member_exclusive_identity_domain
  BEFORE INSERT ON public.organization_member
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_guard_exclusive_identity_domain();
CREATE TRIGGER staff_account_exclusive_identity_domain
  BEFORE INSERT ON public.staff_account
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_guard_exclusive_identity_domain();
