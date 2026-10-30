CREATE TABLE "customer_notification_email_provider_event" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_event_id" text NOT NULL,
	"outbox_id" text,
	"provider_reference" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"state" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "customer_notification_email_provider_event_provider_event_id_unique" UNIQUE("provider_event_id"),
	CONSTRAINT "customer_notification_email_provider_event_state_valid" CHECK ("customer_notification_email_provider_event"."state" in ('PROCESSED','RECONCILIATION_REQUIRED')),
	CONSTRAINT "customer_notification_email_provider_event_hash_valid" CHECK ("customer_notification_email_provider_event"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "customer_notification_email_provider_event_shape" CHECK (("customer_notification_email_provider_event"."state" = 'PROCESSED' and "customer_notification_email_provider_event"."processed_at" is not null and "customer_notification_email_provider_event"."outbox_id" is not null) or ("customer_notification_email_provider_event"."state" = 'RECONCILIATION_REQUIRED' and "customer_notification_email_provider_event"."processed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "customer_notification_email_provider_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_notification_email_outbox" ADD COLUMN "delivery_status" text DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_notification_email_provider_event" ADD CONSTRAINT "customer_notification_email_provider_event_outbox_id_customer_notification_email_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."customer_notification_email_outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_notification_email_provider_event_outbox_idx" ON "customer_notification_email_provider_event" USING btree ("outbox_id","received_at");--> statement-breakpoint
ALTER TABLE "customer_notification_email_outbox" ADD CONSTRAINT "customer_notification_email_delivery_status_valid" CHECK ("customer_notification_email_outbox"."delivery_status" in ('PENDING','DELIVERED','BOUNCED','FAILED','DELAYED','SUPPRESSED'));