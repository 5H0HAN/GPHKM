CREATE OR REPLACE FUNCTION public.gphkm_queue_private_file_delete(target_storage_key text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE file_state text;
BEGIN
  IF session_user <> 'gphkm_runtime'
     OR target_storage_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'private file deletion unavailable' USING ERRCODE = '42501';
  END IF;

  -- Create a queue row for legacy objects that predate the lifecycle table.
  -- The insert also serializes concurrent registrations/deletes for a missing key.
  INSERT INTO public.private_file_object(storage_key, state, next_attempt_at)
  VALUES (target_storage_key, 'DELETE_PENDING', clock_timestamp())
  ON CONFLICT (storage_key) DO NOTHING;

  -- Serialize deletion with linking before checking business references. A
  -- concurrent link either commits first and is observed below, or waits and
  -- then fails because the state is no longer UPLOADING.
  SELECT object_row.state INTO file_state
    FROM public.private_file_object object_row
   WHERE object_row.storage_key = target_storage_key
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'private file deletion unavailable' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (SELECT 1 FROM public.catalog_import_batch b WHERE b.source_object_key = target_storage_key)
     OR EXISTS (SELECT 1 FROM public.supplier_packet_manual_evidence e WHERE e.storage_key = target_storage_key)
     OR EXISTS (SELECT 1 FROM public.supplier_transfer_evidence e WHERE e.storage_key = target_storage_key) THEN
    RAISE EXCEPTION 'private file is still referenced' USING ERRCODE = '23514';
  END IF;

  -- DELETED is terminal. In particular, never make a tombstone claimable again.
  IF file_state <> 'DELETED' THEN
    UPDATE public.private_file_object
       SET state = 'DELETE_PENDING', lease_id = NULL, lease_until = NULL,
           next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE storage_key = target_storage_key;
  END IF;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_queue_private_file_delete(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_queue_private_file_delete(text) TO gphkm_runtime;--> statement-breakpoint
