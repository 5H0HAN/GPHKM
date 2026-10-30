CREATE TABLE "user_appearance_preference" (
	"user_id" text PRIMARY KEY NOT NULL,
	"theme" text DEFAULT 'DARK' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_appearance_theme_valid" CHECK ("user_appearance_preference"."theme" in ('DARK','LIGHT'))
);
--> statement-breakpoint
ALTER TABLE "user_appearance_preference" ADD CONSTRAINT "user_appearance_preference_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE user_appearance_preference ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON user_appearance_preference TO gphkm_runtime;
REVOKE DELETE ON user_appearance_preference FROM gphkm_runtime;
--> statement-breakpoint
CREATE POLICY user_appearance_read ON user_appearance_preference FOR SELECT TO gphkm_runtime
  USING (user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY user_appearance_insert ON user_appearance_preference FOR INSERT TO gphkm_runtime
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY user_appearance_update ON user_appearance_preference FOR UPDATE TO gphkm_runtime
  USING (user_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
