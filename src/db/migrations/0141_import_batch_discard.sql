-- Only unapplied batches may be discarded. Apply history is immutable,
-- so any batch with an apply event must remain available for reconciliation.
-- Keep this as a narrow command because the request runtime cannot DELETE from
-- import tables, and write immutable audit evidence in the same transaction.
-- The existing row guard returned NEW for DELETE, which silently cancels a
-- non-applied row deletion. Return OLD for an allowed delete while preserving
-- the applied-row immutability check.
CREATE OR REPLACE FUNCTION public.gphkm_catalog_import_row_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status = 'APPLIED' OR OLD.applied_listing_id IS NOT NULL THEN
    RAISE EXCEPTION 'applied import rows are immutable' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.gphkm_discard_catalog_import_batch(target_batch_id text, target_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  actor_role text;
  actor_active boolean;
  batch_row public.catalog_import_batch%ROWTYPE;
  row_count integer;
  applied_row_count integer;
  cost_row_count integer;
  apply_event_count integer;
BEGIN
  IF actor_id IS NULL OR target_batch_id IS NULL OR target_batch_id !~ '^[0-9a-f-]{36}$'
     OR target_reason IS NULL OR length(btrim(target_reason)) NOT BETWEEN 5 AND 1000 THEN
    RAISE EXCEPTION 'Import batch unavailable' USING ERRCODE = '42501';
  END IF;

  -- Serialize this command against staff deactivation and role changes.
  PERFORM staff.user_id
    FROM public.staff_account AS staff
   WHERE staff.user_id = actor_id
   FOR SHARE;
  SELECT staff.role, staff.active INTO actor_role, actor_active
    FROM public.staff_account AS staff WHERE staff.user_id = actor_id;
  IF NOT FOUND OR NOT actor_active OR actor_role NOT IN ('ADMIN', 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'Import batch unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT batch.* INTO batch_row
    FROM public.catalog_import_batch AS batch
   WHERE batch.id = target_batch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import batch unavailable' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE import_row.status = 'APPLIED')::integer
    INTO row_count, applied_row_count
    FROM public.catalog_import_row AS import_row
   WHERE import_row.batch_id = target_batch_id;
  IF applied_row_count > 0 OR batch_row.status IN ('PARTIALLY_APPLIED', 'APPLIED') THEN
    RAISE EXCEPTION 'Batches with applied listings cannot be discarded' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer INTO cost_row_count
    FROM public.catalog_import_cost AS cost
   WHERE cost.batch_id = target_batch_id;
  SELECT count(*)::integer INTO apply_event_count
    FROM public.catalog_import_apply_event AS apply_event
   WHERE apply_event.batch_id = target_batch_id;
  IF apply_event_count > 0 THEN
    RAISE EXCEPTION 'Batches with apply history cannot be discarded' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.audit_event (
    id, actor_user_id, action, target_type, target_id, reason_code, metadata
  ) VALUES (
    gen_random_uuid()::text, actor_id, 'CATALOG_IMPORT_BATCH_DISCARDED',
    'catalog_import_batch', target_batch_id, 'STAFF_DISCARDED_IMPORT_BATCH',
    jsonb_build_object(
      'result', 'DISCARDED',
      'supplierId', batch_row.supplier_id,
      'sourceType', batch_row.source_type,
      'sourceReference', batch_row.source_reference,
      'sourceFilename', batch_row.source_filename,
      'sourceBytes', batch_row.source_bytes,
      'contentSha256', batch_row.content_sha256,
      'createdByUserId', batch_row.created_by_user_id,
      'batchCreatedAt', batch_row.created_at,
      'batchStatus', batch_row.status,
      'rowCount', row_count,
      'appliedRowCount', applied_row_count,
      'costRowCount', cost_row_count,
      'applyEventCount', apply_event_count,
      'reason', btrim(target_reason)
    )
  );

  DELETE FROM public.catalog_import_cost AS cost WHERE cost.batch_id = target_batch_id;
  DELETE FROM public.catalog_import_row AS import_row WHERE import_row.batch_id = target_batch_id;
  DELETE FROM public.catalog_import_batch AS batch WHERE batch.id = target_batch_id;

  RETURN jsonb_build_object(
    'batchId', target_batch_id,
    'rowCount', row_count,
    'costRowCount', cost_row_count,
    'applyEventCount', apply_event_count,
    'sourceObjectKey', batch_row.source_object_key
  );
END;
$$;

REVOKE ALL ON FUNCTION public.gphkm_discard_catalog_import_batch(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_discard_catalog_import_batch(text, text) TO gphkm_runtime;
