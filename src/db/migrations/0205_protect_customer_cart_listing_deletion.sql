ALTER TABLE "customer_cart_item" DROP CONSTRAINT "customer_cart_item_listing_id_marketplace_listing_id_fk";
--> statement-breakpoint
ALTER TABLE "customer_cart_item" ADD CONSTRAINT "customer_cart_item_listing_id_marketplace_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."marketplace_listing"("id") ON DELETE restrict ON UPDATE no action;