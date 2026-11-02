-- Keep the SQL entry point bounded even if a future caller bypasses the UI helper.
CREATE OR REPLACE FUNCTION public.gphkm_staff_customer_search(search_term text, state_filter text, result_limit integer, result_offset integer)
RETURNS TABLE (
  customer_id text, customer_name text, customer_email text, email_verified boolean,
  joined_at timestamp without time zone, account_state text, organization_count integer,
  active_organization_count integer, paid_order_count integer, open_support_count integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); query_text text := lower(trim(coalesce(search_term, '')));
  query_pattern text;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'ADMIN') THEN
    RAISE EXCEPTION 'customer directory unavailable' USING ERRCODE = '42501';
  END IF;
  IF length(query_text) > 100 OR state_filter IS NULL OR state_filter NOT IN ('ALL', 'ACTIVE', 'SUSPENDED')
     OR result_limit IS NULL OR result_limit < 1 OR result_limit > 50
     OR result_offset IS NULL OR result_offset < 0 OR result_offset > 99950 THEN
    RAISE EXCEPTION 'invalid customer directory page' USING ERRCODE = '22023';
  END IF;

  IF query_text = '' THEN
    RETURN QUERY
      WITH page_customers AS MATERIALIZED (
        SELECT u.id, u.name, u.email, u.email_verified, u.created_at, c.state
        FROM public.auth_user u
        LEFT JOIN public.customer_account_control c ON c.user_id = u.id
        WHERE NOT EXISTS (SELECT 1 FROM public.staff_account s WHERE s.user_id = u.id)
          AND EXISTS (SELECT 1 FROM public.organization_member customer_membership WHERE customer_membership.user_id = u.id)
          AND (state_filter = 'ALL' OR coalesce(c.state, 'ACTIVE') = state_filter)
        ORDER BY u.created_at DESC, u.id
        LIMIT result_limit OFFSET result_offset
      )
      SELECT p.id, p.name, p.email, p.email_verified, p.created_at,
        coalesce(p.state, 'ACTIVE'),
        count(DISTINCT m.organization_id)::integer,
        count(DISTINCT m.organization_id) FILTER (WHERE m.active AND o.closed_at IS NULL)::integer,
        (SELECT count(*)::integer FROM public.customer_order ord
          WHERE ord.actor_user_id = p.id AND ord.checkout_state = 'PAID'),
        (SELECT count(*)::integer FROM public.support_case sc
          WHERE sc.opened_by_user_id = p.id AND sc.state <> 'CLOSED')
      FROM page_customers p
      LEFT JOIN public.organization_member m ON m.user_id = p.id
      LEFT JOIN public.organization o ON o.id = m.organization_id
      GROUP BY p.id, p.name, p.email, p.email_verified, p.created_at, p.state
      ORDER BY p.created_at DESC, p.id;
  ELSE
    query_pattern := '%' || public.gphkm_escape_like_search(query_text) || '%';
    RETURN QUERY
      WITH matching_customers AS (
        SELECT user_match.id AS customer_id
          FROM public.auth_user user_match
          WHERE lower(user_match.name) LIKE query_pattern ESCAPE E'\\'
        UNION
        SELECT email_match.id
          FROM public.auth_user email_match
          WHERE lower(email_match.email) LIKE query_pattern ESCAPE E'\\'
        UNION
        SELECT search_membership.user_id
          FROM public.organization search_org
          JOIN public.organization_member search_membership ON search_membership.organization_id = search_org.id
          WHERE lower(search_org.name) LIKE query_pattern ESCAPE E'\\'
      ), page_customers AS MATERIALIZED (
        SELECT u.id, u.name, u.email, u.email_verified, u.created_at, c.state
        FROM matching_customers matched
        JOIN public.auth_user u ON u.id = matched.customer_id
        LEFT JOIN public.customer_account_control c ON c.user_id = u.id
        WHERE NOT EXISTS (SELECT 1 FROM public.staff_account s WHERE s.user_id = u.id)
          AND EXISTS (SELECT 1 FROM public.organization_member customer_membership WHERE customer_membership.user_id = u.id)
          AND (state_filter = 'ALL' OR coalesce(c.state, 'ACTIVE') = state_filter)
        ORDER BY u.created_at DESC, u.id
        LIMIT result_limit OFFSET result_offset
      )
      SELECT p.id, p.name, p.email, p.email_verified, p.created_at,
        coalesce(p.state, 'ACTIVE'),
        count(DISTINCT m.organization_id)::integer,
        count(DISTINCT m.organization_id) FILTER (WHERE m.active AND o.closed_at IS NULL)::integer,
        (SELECT count(*)::integer FROM public.customer_order ord
          WHERE ord.actor_user_id = p.id AND ord.checkout_state = 'PAID'),
        (SELECT count(*)::integer FROM public.support_case sc
          WHERE sc.opened_by_user_id = p.id AND sc.state <> 'CLOSED')
      FROM page_customers p
      LEFT JOIN public.organization_member m ON m.user_id = p.id
      LEFT JOIN public.organization o ON o.id = m.organization_id
      GROUP BY p.id, p.name, p.email, p.email_verified, p.created_at, p.state
      ORDER BY p.created_at DESC, p.id;
  END IF;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_staff_customer_search(text, text, integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_staff_customer_search(text, text, integer, integer) TO gphkm_runtime;
