CREATE TABLE "private_file_object" (
	"storage_key" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'UPLOADING' NOT NULL,
	"delete_attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" text,
	"lease_until" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_file_object_key_valid" CHECK ("private_file_object"."storage_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "private_file_object_state_valid" CHECK ("private_file_object"."state" in ('UPLOADING','LINKED','DELETE_PENDING','DELETING','DELETED')),
	CONSTRAINT "private_file_object_attempts_valid" CHECK ("private_file_object"."delete_attempts" >= 0),
	CONSTRAINT "private_file_object_lease_shape" CHECK (("private_file_object"."state" = 'DELETING' and "private_file_object"."lease_id" is not null and "private_file_object"."lease_until" is not null) or ("private_file_object"."state" <> 'DELETING' and "private_file_object"."lease_id" is null and "private_file_object"."lease_until" is null)),
	CONSTRAINT "private_file_object_error_valid" CHECK ("private_file_object"."last_error_code" is null or "private_file_object"."last_error_code" = 'STORAGE_DELETE_FAILED')
);
--> statement-breakpoint
ALTER TABLE "private_file_object" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "private_file_object_cleanup_idx" ON "private_file_object" USING btree ("state","next_attempt_at","created_at");--> statement-breakpoint

REVOKE ALL ON TABLE public.private_file_object FROM PUBLIC, gphkm_runtime, gphkm_worker;--> statement-breakpoint

CREATE FUNCTION public.gphkm_register_private_file_upload(target_storage_key text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF session_user <> 'gphkm_runtime'
     OR target_storage_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'private file upload unavailable' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.private_file_object(storage_key) VALUES (target_storage_key);
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_register_private_file_upload(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_register_private_file_upload(text) TO gphkm_runtime;--> statement-breakpoint

CREATE FUNCTION public.gphkm_link_private_file_upload(target_storage_key text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE file_state text;
BEGIN
  IF session_user <> 'gphkm_runtime'
     OR target_storage_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'private file upload unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT object_row.state INTO file_state
    FROM public.private_file_object object_row
   WHERE object_row.storage_key = target_storage_key
   FOR UPDATE;
  IF NOT FOUND OR file_state <> 'UPLOADING' THEN
    RAISE EXCEPTION 'private file upload unavailable' USING ERRCODE = '23514';
  END IF;

  IF NOT (
    EXISTS (SELECT 1 FROM public.catalog_import_batch b WHERE b.source_object_key = target_storage_key)
    OR EXISTS (SELECT 1 FROM public.supplier_packet_manual_evidence e WHERE e.storage_key = target_storage_key)
    OR EXISTS (SELECT 1 FROM public.supplier_transfer_evidence e WHERE e.storage_key = target_storage_key)
  ) THEN
    RAISE EXCEPTION 'private file reference missing' USING ERRCODE = '23514';
  END IF;

  UPDATE public.private_file_object
     SET state = 'LINKED', updated_at = clock_timestamp()
   WHERE storage_key = target_storage_key;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_link_private_file_upload(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_link_private_file_upload(text) TO gphkm_runtime;--> statement-breakpoint

CREATE FUNCTION public.gphkm_queue_private_file_delete(target_storage_key text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE file_state text;
BEGIN
  IF session_user <> 'gphkm_runtime'
     OR target_storage_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'private file deletion unavailable' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM public.catalog_import_batch b WHERE b.source_object_key = target_storage_key)
     OR EXISTS (SELECT 1 FROM public.supplier_packet_manual_evidence e WHERE e.storage_key = target_storage_key)
     OR EXISTS (SELECT 1 FROM public.supplier_transfer_evidence e WHERE e.storage_key = target_storage_key) THEN
    RAISE EXCEPTION 'private file is still referenced' USING ERRCODE = '23514';
  END IF;

  SELECT object_row.state INTO file_state
    FROM public.private_file_object object_row
   WHERE object_row.storage_key = target_storage_key
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Existing files may predate this lifecycle table; explicit audited deletes
    -- still need a durable queue entry after their business row is removed.
    INSERT INTO public.private_file_object(storage_key, state, next_attempt_at)
    VALUES (target_storage_key, 'DELETE_PENDING', clock_timestamp());
  ELSIF file_state <> 'DELETED' THEN
    UPDATE public.private_file_object
       SET state = 'DELETE_PENDING', lease_id = NULL, lease_until = NULL,
           next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE storage_key = target_storage_key;
  END IF;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_queue_private_file_delete(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_queue_private_file_delete(text) TO gphkm_runtime;--> statement-breakpoint

CREATE FUNCTION public.gphkm_claim_private_file_deletes(target_worker_id text, target_limit integer)
RETURNS TABLE (storage_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE object_row record;
BEGIN
  IF session_user <> 'gphkm_worker' OR target_worker_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR target_limit IS NULL OR target_limit NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'private file cleanup unavailable' USING ERRCODE = '42501';
  END IF;

  FOR object_row IN
    SELECT candidate.storage_key, candidate.state
      FROM public.private_file_object candidate
     WHERE (candidate.state = 'DELETE_PENDING' AND candidate.next_attempt_at <= clock_timestamp())
        OR (candidate.state = 'UPLOADING' AND candidate.created_at <= clock_timestamp() - interval '1 hour')
        OR (candidate.state = 'DELETING' AND candidate.lease_until <= clock_timestamp())
     ORDER BY candidate.next_attempt_at, candidate.created_at, candidate.storage_key
     LIMIT target_limit
     FOR UPDATE OF candidate SKIP LOCKED
  LOOP
    IF EXISTS (SELECT 1 FROM public.catalog_import_batch b WHERE b.source_object_key = object_row.storage_key)
       OR EXISTS (SELECT 1 FROM public.supplier_packet_manual_evidence e WHERE e.storage_key = object_row.storage_key)
       OR EXISTS (SELECT 1 FROM public.supplier_transfer_evidence e WHERE e.storage_key = object_row.storage_key) THEN
      UPDATE public.private_file_object
         SET state = 'LINKED', lease_id = NULL, lease_until = NULL,
             next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE public.private_file_object.storage_key = object_row.storage_key;
      CONTINUE;
    END IF;

    UPDATE public.private_file_object
       SET state = 'DELETING', lease_id = target_worker_id,
           lease_until = clock_timestamp() + interval '2 minutes',
           delete_attempts = delete_attempts + 1, updated_at = clock_timestamp()
     WHERE public.private_file_object.storage_key = object_row.storage_key;
    storage_key := object_row.storage_key;
    RETURN NEXT;
  END LOOP;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_claim_private_file_deletes(text, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_claim_private_file_deletes(text, integer) TO gphkm_worker;--> statement-breakpoint

CREATE FUNCTION public.gphkm_finish_private_file_delete(target_storage_key text, target_worker_id text, target_succeeded boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF session_user <> 'gphkm_worker'
     OR target_storage_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR target_worker_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR target_succeeded IS NULL THEN
    RAISE EXCEPTION 'private file cleanup unavailable' USING ERRCODE = '42501';
  END IF;

  UPDATE public.private_file_object
     SET state = CASE WHEN target_succeeded THEN 'DELETED' ELSE 'DELETE_PENDING' END,
         lease_id = NULL,
         lease_until = NULL,
         next_attempt_at = CASE WHEN target_succeeded THEN clock_timestamp()
           ELSE clock_timestamp() + LEAST(interval '6 hours', interval '30 seconds' * power(2, LEAST(delete_attempts, 16))) END,
         last_error_code = CASE WHEN target_succeeded THEN NULL ELSE 'STORAGE_DELETE_FAILED' END,
         updated_at = clock_timestamp()
   WHERE storage_key = target_storage_key AND state = 'DELETING' AND lease_id = target_worker_id;
  RETURN FOUND;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_finish_private_file_delete(text, text, boolean) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_finish_private_file_delete(text, text, boolean) TO gphkm_worker;--> statement-breakpoint
