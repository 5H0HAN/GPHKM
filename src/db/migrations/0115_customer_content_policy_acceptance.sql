ALTER TABLE "customer_order" ADD COLUMN "content_policy_version" text;--> statement-breakpoint
ALTER TABLE "customer_order" ADD COLUMN "content_policy_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_content_policy_snapshot_valid" CHECK (("customer_order"."content_policy_version" is null and "customer_order"."content_policy_accepted_at" is null) or ("customer_order"."content_policy_version" = 'gphkm-content-policy-v1' and "customer_order"."content_policy_accepted_at" is not null));--> statement-breakpoint
DROP POLICY customer_order_create ON customer_order;--> statement-breakpoint
CREATE POLICY customer_order_create ON customer_order FOR INSERT TO gphkm_runtime WITH CHECK (
  organization_id = nullif(current_setting('app.organization_id', true), '')
  AND actor_user_id = nullif(current_setting('app.user_id', true), '')
  AND checkout_state = 'PENDING_POST' AND paid_ledger_entry_id IS NULL AND customer_status = 'ORDER_RECEIVED'
  AND content_policy_version = 'gphkm-content-policy-v1' AND content_policy_accepted_at IS NOT NULL
  AND public.gphkm_is_active_org_member(organization_id, actor_user_id)
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.gphkm_protect_order_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.actor_user_id <> OLD.actor_user_id
    OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.request_hash <> OLD.request_hash OR NEW.currency <> OLD.currency
    OR NEW.placement_total_minor <> OLD.placement_total_minor OR NEW.writing_total_minor <> OLD.writing_total_minor
    OR NEW.total_minor <> OLD.total_minor OR NEW.content_sharing_notice_version <> OLD.content_sharing_notice_version
    OR NEW.content_policy_version IS DISTINCT FROM OLD.content_policy_version
    OR NEW.content_policy_accepted_at IS DISTINCT FROM OLD.content_policy_accepted_at
    OR NEW.created_at <> OLD.created_at OR OLD.checkout_state <> 'PENDING_POST'
    OR NEW.checkout_state <> 'PAID' OR NEW.paid_ledger_entry_id IS NULL THEN
    RAISE EXCEPTION 'order snapshot mutation rejected' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
