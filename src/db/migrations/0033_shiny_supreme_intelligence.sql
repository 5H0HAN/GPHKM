CREATE TABLE "supplier_packet_acknowledgement" (
	"attempt_id" text PRIMARY KEY NOT NULL,
	"recorded_by_user_id" text NOT NULL,
	"acknowledged_at" timestamp with time zone NOT NULL,
	"reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_packet_ack_reference_valid" CHECK (length(trim("supplier_packet_acknowledgement"."reference")) between 1 and 320 and "supplier_packet_acknowledgement"."reference" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "supplier_packet_acknowledgement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_packet_acknowledgement" ADD CONSTRAINT "supplier_packet_acknowledgement_attempt_id_supplier_packet_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."supplier_packet_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_packet_acknowledgement" ADD CONSTRAINT "supplier_packet_acknowledgement_recorded_by_user_id_auth_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;