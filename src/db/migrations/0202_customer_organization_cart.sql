CREATE TABLE "customer_cart_item" (
	"organization_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"listing_revision" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"draft" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_cart_item_organization_id_listing_id_pk" PRIMARY KEY("organization_id","listing_id"),
	CONSTRAINT "customer_cart_item_listing_revision_positive" CHECK ("customer_cart_item"."listing_revision" > 0),
	CONSTRAINT "customer_cart_item_version_positive" CHECK ("customer_cart_item"."version" > 0),
	CONSTRAINT "customer_cart_item_draft_valid" CHECK (
    jsonb_typeof("customer_cart_item"."draft") = 'object'
    and jsonb_typeof("customer_cart_item"."draft"->'useWriting') = 'boolean'
    and length(coalesce("customer_cart_item"."draft"->>'targetUrl', '')) <= 2048
    and length(coalesce("customer_cart_item"."draft"->>'anchorText', '')) <= 200
    and length(coalesce("customer_cart_item"."draft"->>'instructions', '')) <= 4000
    and length(coalesce("customer_cart_item"."draft"->>'articleText', '')) <= 20000
    and length(coalesce("customer_cart_item"."draft"->>'writingBrief', '')) <= 4000
    and coalesce("customer_cart_item"."draft"->>'targetUrl', '') !~ '[[:cntrl:][:space:]]'
    and coalesce("customer_cart_item"."draft"->>'anchorText', '') !~ '[[:cntrl:]]'
    and coalesce("customer_cart_item"."draft"->>'instructions', '') !~ '[[:cntrl:]]'
    and coalesce("customer_cart_item"."draft"->>'articleText', '') !~ '[[:cntrl:]]'
    and coalesce("customer_cart_item"."draft"->>'writingBrief', '') !~ '[[:cntrl:]]'
  )
);
--> statement-breakpoint
ALTER TABLE "customer_cart_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customer_cart_item_active_member ON public.customer_cart_item
  FOR ALL TO gphkm_runtime
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND public.gphkm_is_active_org_member(
      organization_id, nullif(current_setting('app.user_id', true), '')
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND public.gphkm_is_active_org_member(
      organization_id, nullif(current_setting('app.user_id', true), '')
    )
  );--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_cart_item TO gphkm_runtime;--> statement-breakpoint
ALTER TABLE "customer_cart_item" ADD CONSTRAINT "customer_cart_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_cart_item" ADD CONSTRAINT "customer_cart_item_listing_id_marketplace_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."marketplace_listing"("id") ON DELETE cascade ON UPDATE no action;
