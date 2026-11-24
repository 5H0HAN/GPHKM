ALTER TABLE "customer_cart_item" DROP CONSTRAINT "customer_cart_item_draft_valid";--> statement-breakpoint
ALTER TABLE "customer_cart_item" ADD CONSTRAINT "customer_cart_item_draft_valid" CHECK (
    jsonb_typeof("customer_cart_item"."draft") = 'object'
    and ("customer_cart_item"."draft" - array['targetUrl', 'anchorText', 'instructions', 'articleText', 'writingBrief', 'useWriting']::text[]) = '{}'::jsonb
    and jsonb_typeof("customer_cart_item"."draft"->'targetUrl') = 'string'
    and jsonb_typeof("customer_cart_item"."draft"->'anchorText') = 'string'
    and jsonb_typeof("customer_cart_item"."draft"->'instructions') = 'string'
    and jsonb_typeof("customer_cart_item"."draft"->'articleText') = 'string'
    and jsonb_typeof("customer_cart_item"."draft"->'writingBrief') = 'string'
    and jsonb_typeof("customer_cart_item"."draft"->'useWriting') = 'boolean'
    and length(coalesce("customer_cart_item"."draft"->>'targetUrl', '')) <= 2048
    and length(coalesce("customer_cart_item"."draft"->>'anchorText', '')) <= 200
    and length(coalesce("customer_cart_item"."draft"->>'instructions', '')) <= 4000
    and length(coalesce("customer_cart_item"."draft"->>'articleText', '')) <= 20000
    and length(coalesce("customer_cart_item"."draft"->>'writingBrief', '')) <= 4000
    and coalesce("customer_cart_item"."draft"->>'targetUrl', '') !~ '[[:cntrl:][:space:]]'
    and coalesce("customer_cart_item"."draft"->>'anchorText', '') !~ '[[:cntrl:]]'
    and translate(coalesce("customer_cart_item"."draft"->>'instructions', ''), E'
	', '') !~ '[[:cntrl:]]'
    and translate(coalesce("customer_cart_item"."draft"->>'articleText', ''), E'
	', '') !~ '[[:cntrl:]]'
    and translate(coalesce("customer_cart_item"."draft"->>'writingBrief', ''), E'
	', '') !~ '[[:cntrl:]]'
  );