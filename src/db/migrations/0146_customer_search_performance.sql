CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.gphkm_escape_like_search(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT replace(replace(replace(coalesce(value, ''), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_')
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_escape_like_search(text) FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.gphkm_staff_customer_search_count(search_term text, state_filter text) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor_id text := nullif(current_setting('app.user_id', true), ''); query_text text := lower(trim(coalesce(search_term, '')));
  query_pattern text; total bigint;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'ADMIN') THEN
    RAISE EXCEPTION 'customer directory unavailable' USING ERRCODE = '42501';
  END IF;
  IF length(query_text) > 100 OR state_filter IS NULL OR state_filter NOT IN ('ALL', 'ACTIVE', 'SUSPENDED') THEN
    RAISE EXCEPTION 'invalid customer directory filter' USING ERRCODE = '22023';
  END IF;
  query_pattern := '%' || public.gphkm_escape_like_search(query_text) || '%';
  SELECT count(*) INTO total
    FROM public.auth_user u
    LEFT JOIN public.customer_account_control c ON c.user_id = u.id
    WHERE NOT EXISTS (SELECT 1 FROM public.staff_account s WHERE s.user_id = u.id)
      AND EXISTS (SELECT 1 FROM public.organization_member m WHERE m.user_id = u.id)
      AND (state_filter = 'ALL' OR coalesce(c.state, 'ACTIVE') = state_filter)
      AND (query_text = ''
        OR lower(u.name) LIKE query_pattern ESCAPE E'\\'
        OR lower(u.email) LIKE query_pattern ESCAPE E'\\'
        OR EXISTS (
          SELECT 1 FROM public.organization_member m JOIN public.organization o ON o.id = m.organization_id
          WHERE m.user_id = u.id AND lower(o.name) LIKE query_pattern ESCAPE E'\\'
        ));
  RETURN total;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_staff_customer_search_count(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_staff_customer_search_count(text, text) TO gphkm_runtime;--> statement-breakpoint

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
     OR result_offset IS NULL OR result_offset < 0 OR result_offset > 100000000 THEN
    RAISE EXCEPTION 'invalid customer directory page' USING ERRCODE = '22023';
  END IF;
  query_pattern := '%' || public.gphkm_escape_like_search(query_text) || '%';
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
      AND (query_text = '' OR lower(u.name) LIKE query_pattern ESCAPE E'\\' OR lower(u.email) LIKE query_pattern ESCAPE E'\\'
        OR EXISTS (
          SELECT 1 FROM public.organization_member search_membership
            JOIN public.organization search_org ON search_org.id = search_membership.organization_id
          WHERE search_membership.user_id = u.id AND lower(search_org.name) LIKE query_pattern ESCAPE E'\\'
        ))
    GROUP BY u.id, u.name, u.email, u.email_verified, u.created_at, c.state
    ORDER BY u.created_at DESC, u.id
    LIMIT result_limit OFFSET result_offset;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_staff_customer_search(text, text, integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_staff_customer_search(text, text, integer, integer) TO gphkm_runtime;--> statement-breakpoint

CREATE INDEX "organization_name_lower_trgm_idx" ON "organization" USING gin (lower("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "organization_member_user_org_active_idx" ON "organization_member" USING btree ("user_id","organization_id","active");--> statement-breakpoint
CREATE INDEX "auth_user_created_id_idx" ON "auth_user" USING btree ("created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "auth_user_name_lower_trgm_idx" ON "auth_user" USING gin (lower("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "auth_user_email_lower_trgm_idx" ON "auth_user" USING gin (lower("email") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "marketplace_listing_url_lookup_key_idx" ON "marketplace_listing_url" USING btree (lower(rtrim("website_url", '/')));--> statement-breakpoint
CREATE INDEX "customer_order_actor_paid_created_idx" ON "customer_order" USING btree ("actor_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "customer_order"."checkout_state" = 'PAID';--> statement-breakpoint
CREATE INDEX "support_case_opened_active_idx" ON "support_case" USING btree ("opened_by_user_id") WHERE "support_case"."state" <> 'CLOSED';--> statement-breakpoint
CREATE INDEX "support_case_opened_updated_idx" ON "support_case" USING btree ("opened_by_user_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);
