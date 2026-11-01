-- Staff-only customer directory projections and audited account controls.
CREATE TABLE "customer_account_control" (
	"user_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"reason_code" text NOT NULL,
	"changed_by_user_id" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_account_control_state_valid" CHECK ("customer_account_control"."state" in ('ACTIVE', 'SUSPENDED')),
	CONSTRAINT "customer_account_control_reason_valid" CHECK ("customer_account_control"."reason_code" in ('CUSTOMER_REQUEST', 'POLICY_REVIEW', 'SECURITY_REVIEW', 'OTHER_OPERATIONAL'))
);
--> statement-breakpoint
ALTER TABLE "customer_account_control" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_account_control" ADD CONSTRAINT "customer_account_control_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_control" ADD CONSTRAINT "customer_account_control_changed_by_user_id_auth_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
GRANT SELECT ON public.customer_account_control TO gphkm_runtime;
REVOKE INSERT, UPDATE, DELETE ON public.customer_account_control FROM gphkm_runtime;
CREATE POLICY customer_account_control_self_or_admin_read
  ON public.customer_account_control FOR SELECT TO gphkm_runtime
  USING (
    user_id = nullif(current_setting('app.user_id', true), '')
    OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'ADMIN')
  );

CREATE FUNCTION public.gphkm_customer_account_is_suspended(target_user text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); result boolean;
BEGIN
  IF target_user IS NULL OR actor_id IS NULL
     OR (actor_id <> target_user AND NOT public.gphkm_is_active_staff(actor_id, 'ADMIN')) THEN
    RAISE EXCEPTION 'customer account unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT c.state = 'SUSPENDED' INTO result
    FROM public.customer_account_control c WHERE c.user_id = target_user;
  RETURN coalesce(result, false);
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_customer_account_is_suspended(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_customer_account_is_suspended(text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_staff_customer_search_count(search_term text, state_filter text) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); query_text text := lower(trim(coalesce(search_term, '')));
  total bigint;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'ADMIN') THEN
    RAISE EXCEPTION 'customer directory unavailable' USING ERRCODE = '42501';
  END IF;
  IF length(query_text) > 100 OR state_filter IS NULL OR state_filter NOT IN ('ALL', 'ACTIVE', 'SUSPENDED') THEN
    RAISE EXCEPTION 'invalid customer directory filter' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO total
    FROM public.auth_user u
    LEFT JOIN public.customer_account_control c ON c.user_id = u.id
    WHERE NOT EXISTS (SELECT 1 FROM public.staff_account s WHERE s.user_id = u.id)
      AND EXISTS (SELECT 1 FROM public.organization_member m WHERE m.user_id = u.id)
      AND (state_filter = 'ALL' OR coalesce(c.state, 'ACTIVE') = state_filter)
      AND (query_text = ''
        OR strpos(lower(u.name), query_text) > 0
        OR strpos(lower(u.email), query_text) > 0
        OR EXISTS (
          SELECT 1 FROM public.organization_member m JOIN public.organization o ON o.id = m.organization_id
          WHERE m.user_id = u.id AND strpos(lower(o.name), query_text) > 0
        ));
  RETURN total;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_staff_customer_search_count(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_staff_customer_search_count(text, text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_staff_customer_search(search_term text, state_filter text, result_limit integer, result_offset integer)
RETURNS TABLE (
  customer_id text, customer_name text, customer_email text, email_verified boolean,
  joined_at timestamp without time zone, account_state text, organization_count integer,
  active_organization_count integer, paid_order_count integer, open_support_count integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); query_text text := lower(trim(coalesce(search_term, '')));
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'ADMIN') THEN
    RAISE EXCEPTION 'customer directory unavailable' USING ERRCODE = '42501';
  END IF;
  IF length(query_text) > 100 OR state_filter IS NULL OR state_filter NOT IN ('ALL', 'ACTIVE', 'SUSPENDED')
     OR result_limit IS NULL OR result_limit < 1 OR result_limit > 50
     OR result_offset IS NULL OR result_offset < 0 OR result_offset > 100000000 THEN
    RAISE EXCEPTION 'invalid customer directory page' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT u.id, u.name, u.email, u.email_verified, u.created_at,
      coalesce(c.state, 'ACTIVE'),
      count(DISTINCT m.organization_id)::integer,
      count(DISTINCT m.organization_id) FILTER (WHERE m.active AND o.closed_at IS NULL)::integer,
      (SELECT count(*)::integer FROM public.customer_order ord
        WHERE ord.actor_user_id = u.id AND ord.checkout_state = 'PAID'),
      (SELECT count(*)::integer FROM public.support_case sc
        WHERE sc.opened_by_user_id = u.id AND sc.state <> 'CLOSED')
    FROM public.auth_user u
    LEFT JOIN public.customer_account_control c ON c.user_id = u.id
    LEFT JOIN public.organization_member m ON m.user_id = u.id
    LEFT JOIN public.organization o ON o.id = m.organization_id
    WHERE NOT EXISTS (SELECT 1 FROM public.staff_account s WHERE s.user_id = u.id)
      AND EXISTS (SELECT 1 FROM public.organization_member customer_membership WHERE customer_membership.user_id = u.id)
      AND (state_filter = 'ALL' OR coalesce(c.state, 'ACTIVE') = state_filter)
      AND (query_text = '' OR strpos(lower(u.name), query_text) > 0 OR strpos(lower(u.email), query_text) > 0
        OR EXISTS (
          SELECT 1 FROM public.organization_member search_membership
            JOIN public.organization search_org ON search_org.id = search_membership.organization_id
          WHERE search_membership.user_id = u.id AND strpos(lower(search_org.name), query_text) > 0
        ))
    GROUP BY u.id, u.name, u.email, u.email_verified, u.created_at, c.state
    ORDER BY u.created_at DESC, u.id
    LIMIT result_limit OFFSET result_offset;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_staff_customer_search(text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_staff_customer_search(text, text, integer, integer) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_staff_customer_detail(target_user text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); result jsonb;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'ADMIN') THEN
    RAISE EXCEPTION 'customer record unavailable' USING ERRCODE = '42501';
  END IF;
  IF target_user IS NULL OR length(target_user) > 128 THEN
    RAISE EXCEPTION 'customer record unavailable' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_build_object(
    'customer', jsonb_build_object(
      'id', u.id, 'name', u.name, 'email', u.email, 'emailVerified', u.email_verified, 'joinedAt', u.created_at,
      'accountState', coalesce(c.state, 'ACTIVE'), 'reasonCode', c.reason_code, 'changedAt', c.changed_at
    ),
    'memberships', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'organizationId', o.id, 'organizationName', o.name, 'role', m.role,
        'active', m.active, 'joinedAt', m.created_at, 'closedAt', o.closed_at
      ) ORDER BY o.name, m.created_at)
      FROM public.organization_member m JOIN public.organization o ON o.id = m.organization_id
      WHERE m.user_id = u.id
    ), '[]'::jsonb),
    'orders', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', recent.id, 'createdAt', recent.created_at, 'status', recent.customer_status, 'itemCount', recent.item_count
      ) ORDER BY recent.created_at DESC)
      FROM (
        SELECT ord.id, ord.created_at, ord.customer_status,
          (SELECT count(*)::integer FROM public.customer_order_item oi WHERE oi.order_id = ord.id) AS item_count
        FROM public.customer_order ord
        WHERE ord.actor_user_id = u.id AND ord.checkout_state = 'PAID'
        ORDER BY ord.created_at DESC, ord.id DESC LIMIT 10
      ) recent
    ), '[]'::jsonb),
    'supportCases', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', recent.id, 'summary', recent.summary, 'state', recent.state, 'updatedAt', recent.updated_at
      ) ORDER BY recent.updated_at DESC)
      FROM (
        SELECT sc.id, sc.summary, sc.state, sc.updated_at FROM public.support_case sc
        WHERE sc.opened_by_user_id = u.id ORDER BY sc.updated_at DESC, sc.id DESC LIMIT 10
      ) recent
    ), '[]'::jsonb),
    'closureRequests', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', recent.id, 'organizationName', recent.organization_name, 'summary', recent.summary,
        'state', recent.state, 'updatedAt', recent.updated_at
      ) ORDER BY recent.updated_at DESC)
      FROM (
        SELECT cr.id, o.name AS organization_name, cr.summary, cr.state, cr.updated_at
        FROM public.organization_closure_request cr
        JOIN public.organization o ON o.id = cr.organization_id
        WHERE EXISTS (SELECT 1 FROM public.organization_member m WHERE m.organization_id = cr.organization_id AND m.user_id = u.id)
        ORDER BY cr.updated_at DESC, cr.id DESC LIMIT 10
      ) recent
    ), '[]'::jsonb)
  ) INTO result
  FROM public.auth_user u LEFT JOIN public.customer_account_control c ON c.user_id = u.id
  WHERE u.id = target_user
    AND NOT EXISTS (SELECT 1 FROM public.staff_account s WHERE s.user_id = u.id)
    AND EXISTS (SELECT 1 FROM public.organization_member m WHERE m.user_id = u.id);
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_staff_customer_detail(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_staff_customer_detail(text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_staff_update_customer_membership(
  target_organization text, target_user text, expected_role text, expected_active boolean,
  target_role text, target_active boolean, reason text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); membership_id text;
  current_role text; current_active boolean; other_owners integer;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'ADMIN')
     OR target_organization IS NULL OR target_user IS NULL
     OR expected_role IS NULL OR expected_role NOT IN ('OWNER', 'MEMBER')
     OR target_role IS NULL OR target_role NOT IN ('OWNER', 'MEMBER')
     OR expected_active IS NULL OR target_active IS NULL
     OR reason IS NULL OR reason NOT IN ('CUSTOMER_REQUEST', 'SUPPORT_REVIEW', 'SECURITY_REVIEW', 'CORRECTION') THEN
    RAISE EXCEPTION 'customer membership unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organization o WHERE o.id = target_organization AND o.closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer membership unavailable' USING ERRCODE = '23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-owners:' || target_organization, 0));
  SELECT m.id, m.role, m.active INTO membership_id, current_role, current_active
    FROM public.organization_member m JOIN public.auth_user u ON u.id = m.user_id
    WHERE m.organization_id = target_organization AND m.user_id = target_user
      AND NOT EXISTS (SELECT 1 FROM public.staff_account s WHERE s.user_id = u.id)
    FOR UPDATE OF m;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer membership unavailable' USING ERRCODE = '23514'; END IF;
  IF current_role <> expected_role OR current_active <> expected_active THEN
    RAISE EXCEPTION 'customer membership changed; refresh first' USING ERRCODE = '40001';
  END IF;
  IF current_role = target_role AND current_active = target_active THEN RETURN false; END IF;
  IF current_active AND current_role = 'OWNER' AND (NOT target_active OR target_role <> 'OWNER') THEN
    SELECT count(*) INTO other_owners FROM public.organization_member m
      WHERE m.organization_id = target_organization AND m.user_id <> target_user AND m.role = 'OWNER' AND m.active;
    IF other_owners = 0 THEN RAISE EXCEPTION 'the last active owner cannot be removed or demoted' USING ERRCODE = '23514'; END IF;
  END IF;
  UPDATE public.organization_member SET role = target_role, active = target_active
    WHERE id = membership_id;
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, target_organization, actor_id, 'customer.organization_membership_changed',
      'organization_member', membership_id, reason,
      jsonb_build_object('fromState', current_role || ':' || current_active::text,
        'toState', target_role || ':' || target_active::text));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_staff_update_customer_membership(text, text, text, boolean, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_staff_update_customer_membership(text, text, text, boolean, text, boolean, text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_staff_set_customer_account_state(target_user text, expected_state text, target_state text, reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); current_state text;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'ADMIN')
     OR target_user IS NULL OR expected_state IS NULL OR expected_state NOT IN ('ACTIVE', 'SUSPENDED')
     OR target_state IS NULL OR target_state NOT IN ('ACTIVE', 'SUSPENDED')
     OR reason IS NULL OR reason NOT IN ('CUSTOMER_REQUEST', 'POLICY_REVIEW', 'SECURITY_REVIEW', 'OTHER_OPERATIONAL') THEN
    RAISE EXCEPTION 'customer account unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.auth_user u WHERE u.id = target_user
    AND NOT EXISTS (SELECT 1 FROM public.staff_account s WHERE s.user_id = u.id)
    AND EXISTS (SELECT 1 FROM public.organization_member m WHERE m.user_id = u.id)
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer account unavailable' USING ERRCODE = '23514'; END IF;
  SELECT c.state INTO current_state FROM public.customer_account_control c WHERE c.user_id = target_user FOR UPDATE;
  current_state := coalesce(current_state, 'ACTIVE');
  IF current_state <> expected_state THEN RAISE EXCEPTION 'customer account changed; refresh first' USING ERRCODE = '40001'; END IF;
  IF current_state = target_state THEN RETURN false; END IF;
  INSERT INTO public.customer_account_control(user_id, state, reason_code, changed_by_user_id, changed_at)
    VALUES (target_user, target_state, reason, actor_id, clock_timestamp())
    ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, reason_code = EXCLUDED.reason_code,
      changed_by_user_id = EXCLUDED.changed_by_user_id, changed_at = EXCLUDED.changed_at;
  IF target_state = 'SUSPENDED' THEN
    DELETE FROM public.auth_session WHERE user_id = target_user;
  END IF;
  INSERT INTO public.audit_event(id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, actor_id, 'customer.account_state_changed', 'customer_account', target_user, reason,
      jsonb_build_object('fromState', current_state, 'toState', target_state));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_staff_set_customer_account_state(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_staff_set_customer_account_state(text, text, text, text) TO gphkm_runtime;
