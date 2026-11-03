-- Qualify columns that collide with RETURNS TABLE output variables.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.gphkm_decide_order_item_cancellation(
  target_request_id text, target_decision text, target_decision_reason text
) RETURNS TABLE(request_id text, outcome text, amount_minor numeric, ledger_id text, organization_id text, order_item_id text, applied boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  request_row public.order_item_cancellation_request%ROWTYPE;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
  item_row public.customer_order_item%ROWTYPE;
  order_row public.customer_order%ROWTYPE;
  writing_row public.order_item_writing%ROWTYPE;
  refund_value numeric(20,0);
  writing_refund numeric(20,0) := 0;
  ledger_entry_id text;
  previous_state text;
BEGIN
  IF actor_id IS NULL OR target_request_id IS NULL OR target_request_id !~ '^[0-9a-f-]{36}$'
    OR target_decision IS NULL OR target_decision NOT IN ('APPROVED','DENIED')
    OR target_decision_reason IS NULL OR length(trim(target_decision_reason)) NOT BETWEEN 5 AND 1000
    OR NOT (public.gphkm_is_active_staff(actor_id, 'ADMIN') OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')) THEN
    RAISE EXCEPTION 'cancellation decision unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO request_row FROM public.order_item_cancellation_request WHERE id = target_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cancellation request unavailable' USING ERRCODE = '42501'; END IF;
  IF NOT public.gphkm_staff_can_read_order_item(request_row.order_item_id, actor_id) THEN
    RAISE EXCEPTION 'cancellation request unavailable' USING ERRCODE = '42501';
  END IF;
  IF request_row.state <> 'REQUESTED' THEN
    IF request_row.state = target_decision THEN
      RETURN QUERY SELECT request_row.id, request_row.state, request_row.refund_minor, request_row.wallet_ledger_entry_id,
        request_row.organization_id, request_row.order_item_id, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'cancellation request already decided' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment fulfillment WHERE fulfillment.order_item_id = request_row.order_item_id FOR UPDATE;
  SELECT * INTO item_row FROM public.customer_order_item WHERE id = request_row.order_item_id;
  SELECT * INTO order_row FROM public.customer_order WHERE id = request_row.order_id;
  IF NOT FOUND OR order_row.checkout_state <> 'PAID' OR order_row.organization_id <> request_row.organization_id
    OR fulfillment_row.state <> 'CANCELLATION_REQUESTED' OR fulfillment_row.handed_off_at IS NOT NULL
    OR fulfillment_row.work_started_at IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM public.supplier_packet_item pi JOIN public.supplier_packet_attempt a ON a.packet_id = pi.packet_id
       WHERE pi.order_item_id = request_row.order_item_id AND a.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERED','DELIVERY_ISSUE','MANUAL_SENT')
    ) THEN
    RAISE EXCEPTION 'ordinary cancellation cutoff has passed; use support review' USING ERRCODE = '42501';
  END IF;
  IF public.gphkm_is_active_staff(actor_id, 'ADMIN') AND NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')
    AND fulfillment_row.assigned_admin_id IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'assigned Admin required' USING ERRCODE = '42501';
  END IF;
  previous_state := fulfillment_row.state_before_cancellation;
  IF previous_state IS NULL OR previous_state NOT IN ('CONFIRMED','CONTENT_PREPARATION','AWAITING_CUSTOMER_APPROVAL','READY_FOR_HANDOFF','HANDOFF_PENDING','ON_HOLD')
    OR (previous_state = 'ON_HOLD' AND (fulfillment_row.state_before_hold NOT IN ('CONFIRMED','CONTENT_PREPARATION','AWAITING_CUSTOMER_APPROVAL','READY_FOR_HANDOFF','HANDOFF_PENDING')
      OR NOT EXISTS (SELECT 1 FROM public.supplier_fulfillment_outcome outcome
        JOIN public.support_case c ON c.id = outcome.support_case_id
        JOIN public.order_item_fulfillment_supplier route ON route.order_item_id = outcome.order_item_id
        WHERE outcome.order_item_id = request_row.order_item_id AND outcome.supplier_id = route.supplier_id
          AND c.order_id = request_row.order_id AND c.state NOT IN ('RESOLVED','CLOSED') AND c.merged_into_case_id IS NULL))) THEN
    RAISE EXCEPTION 'cancellation state cannot be restored safely' USING ERRCODE = '23514';
  END IF;
  IF target_decision = 'DENIED' THEN
    UPDATE public.order_item_fulfillment AS fulfillment SET state = CASE WHEN previous_state = 'ON_HOLD' THEN 'ON_HOLD' ELSE previous_state END, state_before_cancellation = NULL, updated_at = now()
     WHERE fulfillment.order_item_id = request_row.order_item_id;
    UPDATE public.order_item_cancellation_request SET state = 'DENIED', decision_by_user_id = actor_id,
      decision_reason = trim(target_decision_reason), decided_at = now() WHERE id = request_row.id;
    RETURN QUERY SELECT request_row.id, 'DENIED'::text, 0::numeric, NULL::text, request_row.organization_id, request_row.order_item_id, true;
    RETURN;
  END IF;

  refund_value := item_row.placement_price_minor;
  IF item_row.writing_selected THEN
    SELECT * INTO writing_row FROM public.order_item_writing writing WHERE writing.order_item_id = item_row.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'writing stage record unavailable' USING ERRCODE = '23514'; END IF;
    writing_refund := CASE
      WHEN writing_row.state = 'WAITING_FOR_FIRST_DRAFT' THEN item_row.writing_first_stage_minor + item_row.writing_final_stage_minor
      WHEN writing_row.state IN ('FIRST_DRAFT_READY','REVISION_REQUESTED') THEN item_row.writing_final_stage_minor
      ELSE 0
    END;
    refund_value := refund_value + writing_refund;
  END IF;
  IF refund_value <= 0 OR refund_value > item_row.placement_price_minor + item_row.writing_price_minor THEN
    RAISE EXCEPTION 'calculated cancellation refund is invalid' USING ERRCODE = '23514';
  END IF;
  ledger_entry_id := gen_random_uuid()::text;
  INSERT INTO public.wallet_ledger_entry(id, organization_id, actor_user_id, kind, delta_minor, currency,
    operation, idempotency_key, related_type, related_id, reason_code)
  VALUES (ledger_entry_id, request_row.organization_id, actor_id, 'ITEM_REFUND', refund_value, 'USD',
    'ITEM_CANCELLATION_REFUND', request_row.id, 'CUSTOMER_ORDER_ITEM', request_row.order_item_id, 'PRE_HANDOFF_CANCELLATION');
  UPDATE public.order_item_fulfillment AS fulfillment SET state = 'CANCELED_REFUNDED', state_before_cancellation = NULL, state_before_hold = NULL,
    customer_status = 'RESOLVED', updated_at = now() WHERE fulfillment.order_item_id = request_row.order_item_id;
  UPDATE public.order_item_cancellation_request SET state = 'APPROVED', decision_by_user_id = actor_id,
    decision_reason = trim(target_decision_reason), refund_minor = refund_value,
    wallet_ledger_entry_id = ledger_entry_id, decided_at = now() WHERE id = request_row.id;
  RETURN QUERY SELECT request_row.id, 'APPROVED'::text, refund_value, ledger_entry_id,
    request_row.organization_id, request_row.order_item_id, true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_decide_order_item_cancellation(text,text,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_decide_order_item_cancellation(text,text,text) TO gphkm_runtime;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_request_post_handoff_refund(text,text,text,text,numeric,text) FROM PUBLIC, gphkm_runtime;--> statement-breakpoint
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.gphkm_request_post_handoff_refund(
  target_request_id text, target_case_id text, target_order_item_id text, target_idempotency_key text,
  target_request_hash text, target_amount numeric, target_reason text
) RETURNS TABLE(request_id text, state text, requested_amount_minor numeric, organization_id text, order_item_id text, applied boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  case_row public.support_case%ROWTYPE;
  order_row public.customer_order%ROWTYPE;
  item_row public.customer_order_item%ROWTYPE;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
  existing public.post_handoff_refund_request%ROWTYPE;
  next_number integer;
  captured numeric(20,0);
  refunded numeric(20,0);
  request_id_value text;
BEGIN
  IF actor_id IS NULL OR target_request_id !~ '^[0-9a-f-]{36}$' OR target_case_id !~ '^[0-9a-f-]{36}$' OR target_order_item_id !~ '^[0-9a-f-]{36}$'
    OR target_idempotency_key IS NULL OR length(target_idempotency_key) NOT BETWEEN 16 AND 128
    OR target_request_hash IS NULL OR target_request_hash !~ '^[0-9a-f]{64}$'
    OR target_amount IS NULL OR target_amount <= 0
    OR target_reason IS NULL OR length(btrim(target_reason)) NOT BETWEEN 5 AND 2000
    OR NOT (public.gphkm_is_active_staff(actor_id, 'ADMIN') OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')) THEN
    RAISE EXCEPTION 'post-handoff refund request unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO case_row FROM public.support_case WHERE id = target_case_id FOR UPDATE;
  IF NOT FOUND OR case_row.order_id IS NULL OR case_row.merged_into_case_id IS NOT NULL THEN RAISE EXCEPTION 'case unavailable' USING ERRCODE = '23514'; END IF;
  IF public.gphkm_is_active_staff(actor_id, 'ADMIN') AND NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')
     AND NOT public.gphkm_support_admin_access(case_row.id, actor_id) THEN
    RAISE EXCEPTION 'assigned Admin required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO order_row FROM public.customer_order WHERE id = case_row.order_id AND checkout_state = 'PAID';
  SELECT * INTO item_row FROM public.customer_order_item WHERE id = target_order_item_id AND order_id = case_row.order_id;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment fulfillment WHERE fulfillment.order_item_id = target_order_item_id FOR UPDATE;
  IF order_row.id IS NULL OR item_row.id IS NULL OR fulfillment_row.order_item_id IS NULL
    OR order_row.organization_id <> case_row.organization_id THEN
    RAISE EXCEPTION 'item is not available for this Support order' USING ERRCODE = '23514';
  END IF;
  IF public.gphkm_is_active_staff(actor_id, 'ADMIN') AND NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')
    AND fulfillment_row.assigned_admin_id IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'assigned Admin required for this item' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO existing FROM public.post_handoff_refund_request existing_request
   WHERE existing_request.organization_id = case_row.organization_id AND existing_request.requested_by_user_id = actor_id
     AND existing_request.request_idempotency_key = target_idempotency_key;
  IF FOUND THEN
    IF existing.request_hash <> target_request_hash OR existing.case_id <> case_row.id OR existing.order_item_id <> target_order_item_id THEN
      RAISE EXCEPTION 'refund request idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing.id, existing.state, existing.requested_amount_minor, existing.organization_id, existing.order_item_id, false;
    RETURN;
  END IF;
  IF case_row.state <> 'FINANCE_REVIEW' THEN
    RAISE EXCEPTION 'case must be in Finance Review' USING ERRCODE = '23514';
  END IF;
  IF order_row.id IS NULL OR item_row.id IS NULL OR fulfillment_row.order_item_id IS NULL
    OR order_row.organization_id <> case_row.organization_id
    OR (fulfillment_row.handed_off_at IS NULL AND fulfillment_row.work_started_at IS NULL)
    OR fulfillment_row.state IN ('COMPLETED', 'CANCELED_REFUNDED') THEN
    RAISE EXCEPTION 'item is not eligible for a post-handoff exception' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.wallet_account wallet WHERE wallet.organization_id = case_row.organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet unavailable' USING ERRCODE = '23514'; END IF;
  captured := item_row.placement_price_minor + item_row.writing_price_minor;
  IF item_row.writing_selected THEN
    IF NOT EXISTS (SELECT 1 FROM public.order_item_writing w WHERE w.order_item_id = item_row.id AND w.state IN ('APPROVED_FIRST','APPROVED_FINAL')) THEN
      RAISE EXCEPTION 'writing service is not complete' USING ERRCODE = '23514';
    END IF;
    captured := item_row.placement_price_minor;
  END IF;
  SELECT coalesce(sum(ledger.delta_minor), 0) INTO refunded FROM public.wallet_ledger_entry ledger
   WHERE ledger.organization_id = case_row.organization_id AND ledger.kind = 'ITEM_REFUND'
     AND ledger.related_type = 'CUSTOMER_ORDER_ITEM' AND ledger.related_id = target_order_item_id;
  IF target_amount > captured - refunded THEN
    RAISE EXCEPTION 'requested refund exceeds remaining item charge' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(max(request_number), 0) + 1 INTO next_number FROM public.post_handoff_refund_request WHERE case_id = case_row.id;
  INSERT INTO public.post_handoff_refund_request(id, organization_id, case_id, order_id, order_item_id, request_number,
    requested_by_user_id, requested_amount_minor, request_reason, request_idempotency_key, request_hash)
  VALUES (target_request_id, case_row.organization_id, case_row.id, case_row.order_id, target_order_item_id, next_number,
    actor_id, target_amount, btrim(target_reason), target_idempotency_key, target_request_hash);
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
  VALUES (gen_random_uuid()::text, case_row.organization_id, actor_id, 'POST_HANDOFF_REFUND_REQUESTED',
    'SUPPORT_CASE', case_row.id, 'POST_HANDOFF_EXCEPTION', jsonb_build_object('result', 'REQUESTED', 'amountMinor', target_amount::text));
  RETURN QUERY SELECT target_request_id, 'REQUESTED'::text, target_amount, case_row.organization_id, target_order_item_id, true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_request_post_handoff_refund(text,text,text,text,text,numeric,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_request_post_handoff_refund(text,text,text,text,text,numeric,text) TO gphkm_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.gphkm_decide_post_handoff_refund(
  target_request_id text, target_decision text, target_amount numeric, target_reason text,
  target_decision_idempotency_key text, target_decision_hash text
) RETURNS TABLE(request_id text, outcome text, amount_minor numeric, ledger_id text, organization_id text, case_id text, order_item_id text, applied boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  request_row public.post_handoff_refund_request%ROWTYPE;
  case_row public.support_case%ROWTYPE;
  item_row public.customer_order_item%ROWTYPE;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
  wallet_id text;
  ledger_entry_id text;
  captured numeric(20,0);
  refunded numeric(20,0);
  approved_amount numeric(20,0) := 0;
  event_id text;
  state_event_id text;
  result_hash text;
  replay boolean := false;
BEGIN
  IF actor_id IS NULL OR target_request_id !~ '^[0-9a-f-]{36}$'
    OR target_decision NOT IN ('APPROVED', 'DENIED')
    OR target_amount IS NULL OR target_amount < 0
    OR target_reason IS NULL OR length(btrim(target_reason)) NOT BETWEEN 5 AND 1000
    OR target_decision_idempotency_key IS NULL OR length(target_decision_idempotency_key) NOT BETWEEN 16 AND 128
    OR target_decision_hash IS NULL OR target_decision_hash !~ '^[0-9a-f]{64}$'
    OR NOT (public.gphkm_is_active_staff(actor_id, 'FINANCE') OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')) THEN
    RAISE EXCEPTION 'post-handoff refund decision unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO request_row FROM public.post_handoff_refund_request WHERE id = target_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'refund request unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO case_row FROM public.support_case WHERE id = coalesce(
    (SELECT merged_into_case_id FROM public.support_case WHERE id = request_row.case_id), request_row.case_id
  ) FOR UPDATE;
  IF NOT FOUND OR case_row.organization_id <> request_row.organization_id OR case_row.order_id <> request_row.order_id THEN
    RAISE EXCEPTION 'case unavailable' USING ERRCODE = '23514';
  END IF;
  IF request_row.state <> 'REQUESTED' THEN
    IF request_row.decision_idempotency_key = target_decision_idempotency_key
      AND request_row.decision_hash = target_decision_hash THEN
      RETURN QUERY SELECT request_row.id, request_row.state, request_row.refund_minor, request_row.wallet_ledger_entry_id,
        request_row.organization_id, case_row.id, request_row.order_item_id, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'refund request already decided' USING ERRCODE = '23514';
  END IF;
  IF case_row.state <> 'FINANCE_REVIEW' THEN
    RAISE EXCEPTION 'case is not in Finance Review' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO item_row FROM public.customer_order_item WHERE id = request_row.order_item_id AND order_id = request_row.order_id;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment fulfillment WHERE fulfillment.order_item_id = request_row.order_item_id FOR UPDATE;
  IF item_row.id IS NULL OR fulfillment_row.order_item_id IS NULL
    OR (fulfillment_row.handed_off_at IS NULL AND fulfillment_row.work_started_at IS NULL)
    OR fulfillment_row.state IN ('COMPLETED', 'CANCELED_REFUNDED') THEN
    RAISE EXCEPTION 'item is not eligible for a post-handoff exception' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.wallet_account wallet WHERE wallet.organization_id = request_row.organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet unavailable' USING ERRCODE = '23514'; END IF;
  captured := item_row.placement_price_minor + item_row.writing_price_minor;
  IF item_row.writing_selected THEN
    IF NOT EXISTS (SELECT 1 FROM public.order_item_writing w WHERE w.order_item_id = item_row.id AND w.state IN ('APPROVED_FIRST','APPROVED_FINAL')) THEN
      RAISE EXCEPTION 'writing service is not complete' USING ERRCODE = '23514';
    END IF;
    captured := item_row.placement_price_minor;
  END IF;
  SELECT coalesce(sum(ledger.delta_minor), 0) INTO refunded FROM public.wallet_ledger_entry ledger
   WHERE ledger.organization_id = request_row.organization_id AND ledger.kind = 'ITEM_REFUND'
     AND ledger.related_type = 'CUSTOMER_ORDER_ITEM' AND ledger.related_id = request_row.order_item_id;
  IF target_decision = 'APPROVED' THEN
    IF target_amount <= 0 OR target_amount > request_row.requested_amount_minor OR target_amount > captured - refunded THEN
      RAISE EXCEPTION 'approved amount exceeds requested amount or remaining item charge' USING ERRCODE = '23514';
    END IF;
    approved_amount := target_amount;
    ledger_entry_id := gen_random_uuid()::text;
    INSERT INTO public.wallet_ledger_entry(id, organization_id, actor_user_id, kind, delta_minor, currency, operation,
      idempotency_key, related_type, related_id, reason_code)
    VALUES (ledger_entry_id, request_row.organization_id, actor_id, 'ITEM_REFUND', approved_amount, 'USD',
      'POST_HANDOFF_CASE_REFUND', request_row.id, 'CUSTOMER_ORDER_ITEM', request_row.order_item_id, 'SUPPORT_EXCEPTION');
  ELSIF target_amount <> 0 THEN
    RAISE EXCEPTION 'denied decision cannot include a refund amount' USING ERRCODE = '22023';
  END IF;
  result_hash := target_decision_hash;
  UPDATE public.post_handoff_refund_request SET state = target_decision, decision_by_user_id = actor_id,
    decision_reason = btrim(target_reason), refund_minor = approved_amount, wallet_ledger_entry_id = ledger_entry_id,
    decision_idempotency_key = target_decision_idempotency_key, decision_hash = result_hash, decided_at = clock_timestamp()
   WHERE id = request_row.id;
  event_id := gen_random_uuid()::text;
  INSERT INTO public.support_case_event(id, case_id, actor_user_id, actor_kind, kind, audience, body, decision,
    idempotency_key, request_hash)
  VALUES (event_id, case_row.id, actor_id, 'STAFF', 'FINANCE_DECISION', 'FINANCE', btrim(target_reason), target_decision,
    target_decision_idempotency_key, target_decision_hash);
  state_event_id := gen_random_uuid()::text;
  INSERT INTO public.support_case_event(id, case_id, actor_user_id, actor_kind, kind, audience, body, from_state, to_state,
    idempotency_key, request_hash)
  VALUES (state_event_id, case_row.id, actor_id, 'STAFF', 'STATE_CHANGED', 'FINANCE',
    'Finance decision recorded and returned to assigned Admin.', 'FINANCE_REVIEW', 'INVESTIGATING',
    gen_random_uuid()::text, target_decision_hash);
  UPDATE public.support_case SET state = 'INVESTIGATING', updated_at = clock_timestamp() WHERE id = case_row.id;
  IF target_decision = 'APPROVED' THEN
    UPDATE public.order_item_fulfillment AS fulfillment SET state = 'CANCELED_REFUNDED', state_before_cancellation = NULL,
      customer_status = 'RESOLVED', updated_at = clock_timestamp()
     WHERE fulfillment.order_item_id = request_row.order_item_id;
    INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, request_row.organization_id, actor_id, 'FULFILLMENT_STATE_CHANGED',
      'CUSTOMER_ORDER_ITEM', request_row.order_item_id, 'POST_HANDOFF_REFUND',
      jsonb_build_object('fromState', fulfillment_row.state, 'toState', 'CANCELED_REFUNDED', 'result', 'CANCELED'));
  END IF;
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
  VALUES (gen_random_uuid()::text, request_row.organization_id, actor_id, 'POST_HANDOFF_REFUND_DECIDED',
    'POST_HANDOFF_REFUND_REQUEST', request_row.id, target_decision,
    jsonb_build_object('result', target_decision, 'amountMinor', approved_amount::text));
  RETURN QUERY SELECT request_row.id, target_decision, approved_amount, ledger_entry_id,
    request_row.organization_id, case_row.id, request_row.order_item_id, true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_decide_post_handoff_refund(text,text,numeric,text,text,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.gphkm_decide_post_handoff_refund(text,text,numeric,text,text,text) TO gphkm_runtime;
