ALTER TABLE "order_item_writing" DROP CONSTRAINT "order_item_writing_state_check";--> statement-breakpoint
ALTER TABLE "order_item_writing" DROP CONSTRAINT "order_item_writing_check4";--> statement-breakpoint
ALTER TABLE "order_item_writing" ADD COLUMN "customer_declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_item_writing" ADD COLUMN "writing_refund_minor" numeric(20, 0) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_item_writing" ADD COLUMN "writing_refund_ledger_entry_id" text;--> statement-breakpoint
ALTER TABLE "order_item_writing" ADD CONSTRAINT "order_item_writing_writing_refund_ledger_entry_id_wallet_ledger_entry_id_fk" FOREIGN KEY ("writing_refund_ledger_entry_id") REFERENCES "public"."wallet_ledger_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_writing" ADD CONSTRAINT "order_item_writing_decline_refund_shape" CHECK (("order_item_writing"."state" = 'CUSTOMER_DECLINED_FINAL' and "order_item_writing"."customer_declined_at" is not null and (("order_item_writing"."writing_refund_minor" = 0 and "order_item_writing"."writing_refund_ledger_entry_id" is null) or ("order_item_writing"."writing_refund_minor" > 0 and "order_item_writing"."writing_refund_ledger_entry_id" is not null))) or ("order_item_writing"."state" <> 'CUSTOMER_DECLINED_FINAL' and "order_item_writing"."customer_declined_at" is null and "order_item_writing"."writing_refund_minor" = 0 and "order_item_writing"."writing_refund_ledger_entry_id" is null));--> statement-breakpoint
ALTER TABLE "order_item_writing" ADD CONSTRAINT "order_item_writing_state_valid" CHECK ("order_item_writing"."state" in ('WAITING_FOR_FIRST_DRAFT', 'FIRST_DRAFT_READY', 'REVISION_REQUESTED', 'FINAL_DRAFT_READY', 'APPROVED_FIRST', 'APPROVED_FINAL', 'CUSTOMER_DECLINED_FINAL'));--> statement-breakpoint
ALTER TABLE "order_item_writing" ADD CONSTRAINT "order_item_writing_stage_consistency" CHECK ((
    ("order_item_writing"."state" = 'WAITING_FOR_FIRST_DRAFT' and "order_item_writing"."first_draft_text" is null and "order_item_writing"."revision_request_text" is null and "order_item_writing"."final_draft_text" is null and "order_item_writing"."approved_article_text" is null)
    or ("order_item_writing"."state" = 'FIRST_DRAFT_READY' and "order_item_writing"."first_draft_text" is not null and "order_item_writing"."revision_request_text" is null and "order_item_writing"."final_draft_text" is null and "order_item_writing"."approved_article_text" is null)
    or ("order_item_writing"."state" = 'REVISION_REQUESTED' and "order_item_writing"."first_draft_text" is not null and "order_item_writing"."revision_request_text" is not null and "order_item_writing"."final_draft_text" is null and "order_item_writing"."approved_article_text" is null)
    or ("order_item_writing"."state" = 'FINAL_DRAFT_READY' and "order_item_writing"."first_draft_text" is not null and "order_item_writing"."revision_request_text" is not null and "order_item_writing"."final_draft_text" is not null and "order_item_writing"."approved_article_text" is null)
    or ("order_item_writing"."state" = 'CUSTOMER_DECLINED_FINAL' and "order_item_writing"."first_draft_text" is not null and "order_item_writing"."revision_request_text" is not null and "order_item_writing"."final_draft_text" is not null and "order_item_writing"."approved_article_text" is null)
    or ("order_item_writing"."state" = 'APPROVED_FIRST' and "order_item_writing"."first_draft_text" is not null and "order_item_writing"."revision_request_text" is null and "order_item_writing"."final_draft_text" is null and "order_item_writing"."approved_article_text" = "order_item_writing"."first_draft_text")
    or ("order_item_writing"."state" = 'APPROVED_FINAL' and "order_item_writing"."first_draft_text" is not null and "order_item_writing"."revision_request_text" is not null and "order_item_writing"."final_draft_text" is not null and "order_item_writing"."approved_article_text" = "order_item_writing"."final_draft_text")
  ));
--> statement-breakpoint
CREATE FUNCTION public.gphkm_decline_order_item_writing(target_item_id text)
RETURNS TABLE(state text, refund_minor numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  org_id text := nullif(current_setting('app.organization_id', true), '');
  order_row public.customer_order%ROWTYPE;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
  item_row public.customer_order_item%ROWTYPE;
  writing_row public.order_item_writing%ROWTYPE;
  ledger_id text;
  now_at timestamptz := now();
BEGIN
  IF actor_id IS NULL OR org_id IS NULL OR target_item_id IS NULL OR length(target_item_id) > 128 THEN
    RAISE EXCEPTION 'writing item unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT o.* INTO order_row FROM public.customer_order_item i
    JOIN public.customer_order o ON o.id = i.order_id
   WHERE i.id = target_item_id AND o.organization_id = org_id AND o.actor_user_id = actor_id
     AND o.checkout_state = 'PAID' AND i.writing_selected;
  IF NOT FOUND OR NOT public.gphkm_is_active_org_member(org_id, actor_id) THEN
    RAISE EXCEPTION 'writing item unavailable' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('gphkm:wallet-risk:' || org_id, 0));
  PERFORM 1 FROM public.organization WHERE id = org_id AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT public.gphkm_is_active_org_member(org_id, actor_id) THEN
    RAISE EXCEPTION 'writing item unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment WHERE order_item_id = target_item_id FOR UPDATE;
  IF fulfillment_row.order_item_id IS NULL THEN
    RAISE EXCEPTION 'writing item unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO item_row FROM public.customer_order_item WHERE id = target_item_id;
  SELECT * INTO writing_row FROM public.order_item_writing WHERE order_item_id = target_item_id FOR UPDATE;
  IF writing_row.order_item_id IS NULL OR item_row.id IS NULL OR item_row.writing_selected IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'writing item unavailable' USING ERRCODE = '42501';
  END IF;

  IF writing_row.state = 'CUSTOMER_DECLINED_FINAL' THEN
    RETURN QUERY SELECT writing_row.state, writing_row.writing_refund_minor;
    RETURN;
  END IF;
  IF writing_row.state <> 'FINAL_DRAFT_READY' OR fulfillment_row.state <> 'AWAITING_CUSTOMER_APPROVAL'
    OR fulfillment_row.handed_off_at IS NOT NULL OR fulfillment_row.work_started_at IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM public.supplier_packet_item pi JOIN public.supplier_packet_attempt a ON a.packet_id = pi.packet_id
       WHERE pi.order_item_id = target_item_id AND a.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERED','DELIVERY_ISSUE','MANUAL_SENT')
    ) THEN
    RAISE EXCEPTION 'final writing decline is unavailable after fulfillment has advanced' USING ERRCODE = '42501';
  END IF;

  IF item_row.writing_final_stage_minor > 0 THEN
    ledger_id := gen_random_uuid()::text;
    INSERT INTO public.wallet_ledger_entry(id, organization_id, actor_user_id, kind, delta_minor, currency,
      operation, idempotency_key, related_type, related_id, reason_code)
    VALUES (ledger_id, org_id, actor_id, 'ITEM_REFUND', item_row.writing_final_stage_minor, 'USD',
      'WRITING_STAGE_REFUND', 'writing-decline-final:' || target_item_id,
      'CUSTOMER_ORDER_ITEM', target_item_id, 'UNDELIVERED_FINAL_WRITING_STAGE');
  END IF;

  UPDATE public.order_item_writing SET state = 'CUSTOMER_DECLINED_FINAL', customer_declined_at = now_at,
    writing_refund_minor = item_row.writing_final_stage_minor,
    writing_refund_ledger_entry_id = ledger_id, updated_at = now_at
   WHERE order_item_id = target_item_id;
  RETURN QUERY SELECT 'CUSTOMER_DECLINED_FINAL'::text, item_row.writing_final_stage_minor;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_decline_order_item_writing(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_decline_order_item_writing(text) TO gphkm_runtime;
