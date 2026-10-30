-- Text-only writing drafts and one included revision, scoped to the ordering customer and assigned staff.
DO $$
DECLARE order_owner name;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO order_owner FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'customer_order_item';
  IF current_user = 'gphkm_runtime' OR order_owner IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'writing workflow migration must run as the order table owner, never the runtime role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gphkm_runtime' AND rolbypassrls) THEN
    RAISE EXCEPTION 'gphkm_runtime must not bypass row-level security';
  END IF;
END
$$;

CREATE TABLE order_item_writing (
  order_item_id text PRIMARY KEY REFERENCES customer_order_item(id),
  state text NOT NULL DEFAULT 'WAITING_FOR_FIRST_DRAFT' CHECK (state IN (
    'WAITING_FOR_FIRST_DRAFT','FIRST_DRAFT_READY','REVISION_REQUESTED','FINAL_DRAFT_READY','APPROVED_FIRST','APPROVED_FINAL'
  )),
  first_draft_text text,
  first_draft_submitted_at timestamptz,
  revision_request_text text,
  revision_requested_at timestamptz,
  final_draft_text text,
  final_draft_submitted_at timestamptz,
  approved_article_text text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((first_draft_text IS NULL AND first_draft_submitted_at IS NULL)
      OR (first_draft_text IS NOT NULL AND length(btrim(first_draft_text)) BETWEEN 1 AND 20000 AND first_draft_submitted_at IS NOT NULL)),
  CHECK ((revision_request_text IS NULL AND revision_requested_at IS NULL)
      OR (revision_request_text IS NOT NULL AND length(btrim(revision_request_text)) BETWEEN 1 AND 2000 AND revision_requested_at IS NOT NULL)),
  CHECK ((final_draft_text IS NULL AND final_draft_submitted_at IS NULL)
      OR (final_draft_text IS NOT NULL AND length(btrim(final_draft_text)) BETWEEN 1 AND 20000 AND final_draft_submitted_at IS NOT NULL)),
  CHECK ((approved_article_text IS NULL AND approved_at IS NULL)
      OR (approved_article_text IS NOT NULL AND length(btrim(approved_article_text)) BETWEEN 1 AND 20000 AND approved_at IS NOT NULL)),
  CHECK (
    (state = 'WAITING_FOR_FIRST_DRAFT' AND first_draft_text IS NULL AND revision_request_text IS NULL AND final_draft_text IS NULL AND approved_article_text IS NULL)
    OR (state = 'FIRST_DRAFT_READY' AND first_draft_text IS NOT NULL AND revision_request_text IS NULL AND final_draft_text IS NULL AND approved_article_text IS NULL)
    OR (state = 'REVISION_REQUESTED' AND first_draft_text IS NOT NULL AND revision_request_text IS NOT NULL AND final_draft_text IS NULL AND approved_article_text IS NULL)
    OR (state = 'FINAL_DRAFT_READY' AND first_draft_text IS NOT NULL AND revision_request_text IS NOT NULL AND final_draft_text IS NOT NULL AND approved_article_text IS NULL)
    OR (state = 'APPROVED_FIRST' AND first_draft_text IS NOT NULL AND revision_request_text IS NULL AND final_draft_text IS NULL AND approved_article_text = first_draft_text)
    OR (state = 'APPROVED_FINAL' AND first_draft_text IS NOT NULL AND revision_request_text IS NOT NULL AND final_draft_text IS NOT NULL AND approved_article_text = final_draft_text)
  )
);
CREATE INDEX order_item_writing_state_updated_idx ON order_item_writing(state, updated_at);
ALTER TABLE order_item_writing ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON order_item_writing TO gphkm_runtime;
REVOKE UPDATE, DELETE ON order_item_writing FROM gphkm_runtime;

CREATE POLICY order_item_writing_customer_read ON order_item_writing FOR SELECT TO gphkm_runtime USING (
  EXISTS (
    SELECT 1 FROM public.customer_order_item oi JOIN public.customer_order o ON o.id = oi.order_id
     WHERE oi.id = order_item_writing.order_item_id AND oi.writing_selected
       AND o.actor_user_id = nullif(current_setting('app.user_id', true), '')
       AND o.organization_id = nullif(current_setting('app.organization_id', true), '')
       AND public.gphkm_is_active_org_member(o.organization_id, nullif(current_setting('app.user_id', true), ''))
  )
);
CREATE POLICY order_item_writing_staff_read ON order_item_writing FOR SELECT TO gphkm_runtime USING (
  public.gphkm_staff_can_read_order_item(order_item_id, nullif(current_setting('app.user_id', true), ''))
);
CREATE POLICY order_item_writing_checkout_insert ON order_item_writing FOR INSERT TO gphkm_runtime WITH CHECK (
  state = 'WAITING_FOR_FIRST_DRAFT' AND first_draft_text IS NULL AND revision_request_text IS NULL
  AND final_draft_text IS NULL AND approved_article_text IS NULL
  AND EXISTS (
    SELECT 1 FROM public.customer_order_item oi JOIN public.customer_order o ON o.id = oi.order_id
     WHERE oi.id = order_item_writing.order_item_id AND oi.writing_selected
       AND o.checkout_state = 'PENDING_POST' AND o.actor_user_id = nullif(current_setting('app.user_id', true), '')
       AND o.organization_id = nullif(current_setting('app.organization_id', true), '')
       AND public.gphkm_is_active_org_member(o.organization_id, nullif(current_setting('app.user_id', true), ''))
  )
);

-- All mutations pass through this narrow state transition function; direct UPDATE is revoked.
CREATE FUNCTION public.gphkm_advance_order_item_writing(target_item text, command text, body text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor text := nullif(current_setting('app.user_id', true), '');
  organization_ref text := nullif(current_setting('app.organization_id', true), '');
  writing_row public.order_item_writing%ROWTYPE;
  order_ref public.customer_order%ROWTYPE;
  next_state text;
  next_article text;
  now_at timestamptz := now();
  staff_actor boolean;
BEGIN
  IF actor IS NULL OR target_item IS NULL OR length(target_item) > 128 THEN
    RAISE EXCEPTION 'writing item unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT w.* INTO writing_row FROM public.order_item_writing w WHERE w.order_item_id = target_item FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'writing item unavailable' USING ERRCODE = '42501'; END IF;
  SELECT o.* INTO order_ref FROM public.customer_order_item oi JOIN public.customer_order o ON o.id = oi.order_id
   WHERE oi.id = target_item AND oi.writing_selected AND o.checkout_state = 'PAID';
  IF NOT FOUND THEN RAISE EXCEPTION 'writing item unavailable' USING ERRCODE = '42501'; END IF;
  staff_actor := (public.gphkm_is_active_staff(actor, 'ADMIN') OR public.gphkm_is_active_staff(actor, 'SUPER_ADMIN'))
    AND public.gphkm_staff_can_read_order_item(target_item, actor);

  IF command IN ('FIRST_DRAFT', 'FINAL_DRAFT') THEN
    IF NOT staff_actor OR body IS NULL OR length(btrim(body)) NOT BETWEEN 1 AND 20000
       OR replace(replace(replace(body, chr(9), ''), chr(10), ''), chr(13), '') ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'writing draft unavailable' USING ERRCODE = '42501';
    END IF;
    IF command = 'FIRST_DRAFT' AND writing_row.state = 'WAITING_FOR_FIRST_DRAFT' THEN
      next_state := 'FIRST_DRAFT_READY';
      UPDATE public.order_item_writing SET state = next_state, first_draft_text = btrim(body),
        first_draft_submitted_at = now_at, updated_at = now_at WHERE order_item_id = target_item;
    ELSIF command = 'FINAL_DRAFT' AND writing_row.state = 'REVISION_REQUESTED' THEN
      next_state := 'FINAL_DRAFT_READY';
      UPDATE public.order_item_writing SET state = next_state, final_draft_text = btrim(body),
        final_draft_submitted_at = now_at, updated_at = now_at WHERE order_item_id = target_item;
    ELSE
      RAISE EXCEPTION 'writing draft transition unavailable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF order_ref.actor_user_id <> actor OR order_ref.organization_id <> organization_ref
       OR NOT public.gphkm_is_active_org_member(order_ref.organization_id, actor) THEN
      RAISE EXCEPTION 'writing customer unavailable' USING ERRCODE = '42501';
    END IF;
    IF command = 'REQUEST_REVISION' AND writing_row.state = 'FIRST_DRAFT_READY'
       AND body IS NOT NULL AND length(btrim(body)) BETWEEN 1 AND 2000
       AND replace(replace(replace(body, chr(9), ''), chr(10), ''), chr(13), '') !~ '[[:cntrl:]]' THEN
      next_state := 'REVISION_REQUESTED';
      UPDATE public.order_item_writing SET state = next_state, revision_request_text = btrim(body),
        revision_requested_at = now_at, updated_at = now_at WHERE order_item_id = target_item;
    ELSIF command = 'APPROVE' AND writing_row.state = 'FIRST_DRAFT_READY' THEN
      next_state := 'APPROVED_FIRST'; next_article := writing_row.first_draft_text;
      UPDATE public.order_item_writing SET state = next_state, approved_article_text = next_article,
        approved_at = now_at, updated_at = now_at WHERE order_item_id = target_item;
    ELSIF command = 'APPROVE' AND writing_row.state = 'FINAL_DRAFT_READY' THEN
      next_state := 'APPROVED_FINAL'; next_article := writing_row.final_draft_text;
      UPDATE public.order_item_writing SET state = next_state, approved_article_text = next_article,
        approved_at = now_at, updated_at = now_at WHERE order_item_id = target_item;
    ELSE
      RAISE EXCEPTION 'writing customer transition unavailable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN next_state;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_advance_order_item_writing(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_advance_order_item_writing(text, text, text) TO gphkm_runtime;
