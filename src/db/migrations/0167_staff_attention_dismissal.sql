CREATE TABLE "staff_attention_dismissal" (
	"staff_user_id" text NOT NULL,
	"task_key" text NOT NULL,
	"task_version" text NOT NULL,
	"done_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_attention_dismissal_pk" PRIMARY KEY("staff_user_id","task_key"),
	CONSTRAINT "staff_attention_task_key_valid" CHECK (length("staff_attention_dismissal"."task_key") between 1 and 240),
	CONSTRAINT "staff_attention_task_version_valid" CHECK ("staff_attention_dismissal"."task_version" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "staff_attention_dismissal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "staff_attention_dismissal" ADD CONSTRAINT "staff_attention_dismissal_staff_user_id_auth_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_attention_dismissal TO gphkm_runtime;--> statement-breakpoint
CREATE POLICY staff_attention_dismissal_self ON public.staff_attention_dismissal FOR ALL TO gphkm_runtime
  USING (
    staff_user_id = nullif(current_setting('app.user_id', true), '')
    AND public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''))
  )
  WITH CHECK (
    staff_user_id = nullif(current_setting('app.user_id', true), '')
    AND public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''))
  );
