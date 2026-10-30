CREATE TABLE "supplier_transfer_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"transfer_event_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"file_kind" text NOT NULL,
	"file_name" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_transfer_evidence_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "supplier_transfer_evidence_event_uq" UNIQUE("transfer_event_id"),
	CONSTRAINT "supplier_transfer_evidence_kind_valid" CHECK ("supplier_transfer_evidence"."file_kind" in ('EML','PDF')),
	CONSTRAINT "supplier_transfer_evidence_size_valid" CHECK ("supplier_transfer_evidence"."byte_size" between 1 and 5242880),
	CONSTRAINT "supplier_transfer_evidence_hash_valid" CHECK ("supplier_transfer_evidence"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "supplier_transfer_evidence_key_valid" CHECK ("supplier_transfer_evidence"."storage_key" ~ '^[0-9a-f-]{36}$'),
	CONSTRAINT "supplier_transfer_evidence_filename_valid" CHECK (length("supplier_transfer_evidence"."file_name") between 1 and 180 and "supplier_transfer_evidence"."file_name" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "supplier_transfer_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_transfer_evidence" ADD CONSTRAINT "supplier_transfer_evidence_transfer_event_id_supplier_transfer_event_id_fk" FOREIGN KEY ("transfer_event_id") REFERENCES "public"."supplier_transfer_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_transfer_evidence" ADD CONSTRAINT "supplier_transfer_evidence_uploaded_by_user_id_auth_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_transfer_evidence_created_idx" ON "supplier_transfer_evidence" USING btree ("created_at");
--> statement-breakpoint
GRANT SELECT, INSERT ON public.supplier_transfer_evidence TO gphkm_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON public.supplier_transfer_evidence FROM gphkm_runtime;
--> statement-breakpoint
CREATE POLICY supplier_transfer_evidence_finance_read ON public.supplier_transfer_evidence FOR SELECT TO gphkm_runtime USING (
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
  public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
--> statement-breakpoint
CREATE POLICY supplier_transfer_evidence_finance_insert ON public.supplier_transfer_evidence FOR INSERT TO gphkm_runtime WITH CHECK (
  uploaded_by_user_id = nullif(current_setting('app.user_id', true), '') AND (
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE') OR
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
  )
);
--> statement-breakpoint
CREATE FUNCTION public.gphkm_supplier_transfer_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.uploaded_by_user_id <> nullif(current_setting('app.user_id', true), '')
     OR NOT EXISTS (
       SELECT 1 FROM public.audit_event event
        WHERE event.actor_user_id = NEW.uploaded_by_user_id
          AND event.action = 'SUPPLIER_TRANSFER_EVIDENCE_ATTACHED'
          AND event.target_type = 'SUPPLIER_TRANSFER_EVIDENCE'
          AND event.target_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'supplier transfer evidence requires an authenticated Finance actor and audit evidence';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_supplier_transfer_evidence_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER supplier_transfer_evidence_guard BEFORE INSERT ON public.supplier_transfer_evidence
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_transfer_evidence_guard();
--> statement-breakpoint
CREATE TRIGGER supplier_transfer_evidence_immutable BEFORE UPDATE OR DELETE ON public.supplier_transfer_evidence
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_finance_append_only();
--> statement-breakpoint
CREATE FUNCTION public.gphkm_validate_supplier_transfer_has_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.supplier_transfer_evidence evidence
     WHERE evidence.transfer_event_id = NEW.id
       AND evidence.uploaded_by_user_id = NEW.actor_user_id
  ) THEN
    RAISE EXCEPTION 'supplier transfer requires a private evidence file uploaded by the recording Finance actor'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_validate_supplier_transfer_has_evidence() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER supplier_transfer_requires_evidence
  AFTER INSERT ON public.supplier_transfer_event DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_validate_supplier_transfer_has_evidence();
