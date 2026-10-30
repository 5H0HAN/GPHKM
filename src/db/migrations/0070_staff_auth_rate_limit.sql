CREATE TABLE "auth_staff_rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "auth_staff_rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE INDEX "auth_staff_rate_limit_last_request_idx" ON "auth_staff_rate_limit" USING btree ("last_request");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_staff_rate_limit TO gphkm_runtime;
