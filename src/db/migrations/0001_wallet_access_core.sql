CREATE TABLE "access_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ledger_entry_id" text NOT NULL,
	"policy_version" integer NOT NULL,
	"duration" text NOT NULL,
	"state" text DEFAULT 'ACTIVE' NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp,
	"suspension_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "access_grant_ledger_entry_id_unique" UNIQUE("ledger_entry_id"),
	CONSTRAINT "access_grant_duration_valid" CHECK ("access_grant"."duration" in ('SIX_MONTHS', 'ONE_YEAR', 'UNRESTRICTED')),
	CONSTRAINT "access_grant_state_valid" CHECK ("access_grant"."state" in ('ACTIVE', 'SUSPENDED', 'REVOKED')),
	CONSTRAINT "access_grant_interval_valid" CHECK ("access_grant"."ends_at" is null or "access_grant"."ends_at" > "access_grant"."starts_at"),
	CONSTRAINT "access_grant_unrestricted_valid" CHECK (("access_grant"."duration" = 'UNRESTRICTED' and "access_grant"."ends_at" is null) or ("access_grant"."duration" <> 'UNRESTRICTED' and "access_grant"."ends_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "access_grant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "access_policy" (
	"id" integer PRIMARY KEY NOT NULL,
	"minimum_minor" numeric(20, 0) NOT NULL,
	"duration" text NOT NULL,
	"version" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "access_policy_singleton" CHECK ("access_policy"."id" = 1),
	CONSTRAINT "access_policy_minimum_positive" CHECK ("access_policy"."minimum_minor" > 0),
	CONSTRAINT "access_policy_duration_valid" CHECK ("access_policy"."duration" in ('SIX_MONTHS', 'ONE_YEAR', 'UNRESTRICTED'))
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"actor_user_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason_code" text,
	"correlation_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"provider" text DEFAULT 'STRIPE' NOT NULL,
	"state" text DEFAULT 'CREATED' NOT NULL,
	"amount_minor" numeric(20, 0) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"provider_payment_id" text,
	"settled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempt_provider_payment_id_unique" UNIQUE("provider_payment_id"),
	CONSTRAINT "payment_attempt_idempotency_unique" UNIQUE("organization_id","actor_user_id","idempotency_key"),
	CONSTRAINT "payment_attempt_stripe_usd" CHECK ("payment_attempt"."provider" = 'STRIPE' and "payment_attempt"."currency" = 'USD'),
	CONSTRAINT "payment_attempt_positive_amount" CHECK ("payment_attempt"."amount_minor" > 0),
	CONSTRAINT "payment_attempt_state_valid" CHECK ("payment_attempt"."state" in ('CREATED', 'PENDING', 'SETTLED', 'FAILED', 'CANCELED', 'DISPUTED', 'REVERSED'))
);
--> statement-breakpoint
ALTER TABLE "payment_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "provider_event" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"state" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payment_attempt_id" text,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	CONSTRAINT "provider_event_identity_unique" UNIQUE("provider","provider_event_id"),
	CONSTRAINT "provider_event_stripe_only" CHECK ("provider_event"."provider" = 'STRIPE'),
	CONSTRAINT "provider_event_state_valid" CHECK ("provider_event"."state" in ('RECEIVED', 'VERIFIED', 'REJECTED', 'PROCESSED', 'RECONCILIATION_REQUIRED'))
);
--> statement-breakpoint
CREATE TABLE "wallet_account" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"balance_minor" numeric(20, 0) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_account_usd_only" CHECK ("wallet_account"."currency" = 'USD'),
	CONSTRAINT "wallet_account_nonnegative" CHECK ("wallet_account"."balance_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "wallet_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wallet_hold" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ledger_entry_id" text,
	"payment_attempt_id" text,
	"amount_minor" numeric(20, 0) NOT NULL,
	"state" text DEFAULT 'ACTIVE' NOT NULL,
	"reason_code" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"released_at" timestamp,
	CONSTRAINT "wallet_hold_positive_amount" CHECK ("wallet_hold"."amount_minor" > 0),
	CONSTRAINT "wallet_hold_state_valid" CHECK ("wallet_hold"."state" in ('ACTIVE', 'RELEASED', 'CAPTURED'))
);
--> statement-breakpoint
ALTER TABLE "wallet_hold" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wallet_ledger_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text,
	"kind" text NOT NULL,
	"delta_minor" numeric(20, 0) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"related_type" text,
	"related_id" text,
	"reason_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_ledger_idempotency_unique" UNIQUE("organization_id","operation","idempotency_key"),
	CONSTRAINT "wallet_ledger_usd_only" CHECK ("wallet_ledger_entry"."currency" = 'USD'),
	CONSTRAINT "wallet_ledger_kind_valid" CHECK ("wallet_ledger_entry"."kind" in ('TOP_UP', 'ORDER_DEBIT', 'ITEM_REFUND', 'REVERSAL', 'ADJUSTMENT')),
	CONSTRAINT "wallet_ledger_nonzero" CHECK ("wallet_ledger_entry"."delta_minor" <> 0),
	CONSTRAINT "wallet_ledger_kind_sign" CHECK (("wallet_ledger_entry"."kind" = 'ORDER_DEBIT' and "wallet_ledger_entry"."delta_minor" < 0) or ("wallet_ledger_entry"."kind" <> 'ORDER_DEBIT' and "wallet_ledger_entry"."delta_minor" > 0))
);
--> statement-breakpoint
ALTER TABLE "wallet_ledger_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_ledger_entry_id_wallet_ledger_entry_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."wallet_ledger_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_policy" ADD CONSTRAINT "access_policy_updated_by_auth_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_event" ADD CONSTRAINT "provider_event_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_account" ADD CONSTRAINT "wallet_account_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_hold" ADD CONSTRAINT "wallet_hold_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_hold" ADD CONSTRAINT "wallet_hold_ledger_entry_id_wallet_ledger_entry_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."wallet_ledger_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_hold" ADD CONSTRAINT "wallet_hold_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_entry" ADD CONSTRAINT "wallet_ledger_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_entry" ADD CONSTRAINT "wallet_ledger_entry_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grant_org_interval_idx" ON "access_grant" USING btree ("organization_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "audit_event_org_created_idx" ON "audit_event" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_event_target_idx" ON "audit_event" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_attempt_org_created_idx" ON "payment_attempt" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "provider_event_state_received_idx" ON "provider_event" USING btree ("state","received_at");--> statement-breakpoint
CREATE INDEX "wallet_hold_org_state_idx" ON "wallet_hold" USING btree ("organization_id","state");--> statement-breakpoint
CREATE INDEX "wallet_ledger_org_created_idx" ON "wallet_ledger_entry" USING btree ("organization_id","created_at");