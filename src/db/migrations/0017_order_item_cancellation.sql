-- Per-item ordinary cancellation and policy-calculated wallet refund.
CREATE TABLE order_item_cancellation_request (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id),
  order_id text NOT NULL REFERENCES customer_order(id),
  order_item_id text NOT NULL REFERENCES customer_order_item(id),
  requested_by_user_id text NOT NULL REFERENCES auth_user(id),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  state text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED','APPROVED','DENIED')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  decision_by_user_id text REFERENCES auth_user(id),
  decision_reason text,
  refund_minor numeric(20,0) NOT NULL DEFAULT 0 CHECK (refund_minor >= 0),
  wallet_ledger_entry_id text REFERENCES wallet_ledger_entry(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT order_item_cancellation_request_idempotency_uq UNIQUE (organization_id, requested_by_user_id, idempotency_key),
  CONSTRAINT order_item_cancellation_decision_shape CHECK (
    (state = 'REQUESTED' AND decision_by_user_id IS NULL AND decision_reason IS NULL AND decided_at IS NULL AND refund_minor = 0 AND wallet_ledger_entry_id IS NULL)
    OR (state = 'DENIED' AND decision_by_user_id IS NOT NULL AND decision_reason IS NOT NULL AND decided_at IS NOT NULL AND refund_minor = 0 AND wallet_ledger_entry_id IS NULL)
    OR (state = 'APPROVED' AND decision_by_user_id IS NOT NULL AND decision_reason IS NOT NULL AND decided_at IS NOT NULL AND refund_minor > 0 AND wallet_ledger_entry_id IS NOT NULL)
  )
);
CREATE INDEX order_item_cancellation_item_requested_idx ON order_item_cancellation_request(order_item_id, requested_at);
CREATE INDEX order_item_cancellation_org_state_idx ON order_item_cancellation_request(organization_id, state, requested_at);
CREATE UNIQUE INDEX order_item_cancellation_one_open_uq ON order_item_cancellation_request(order_item_id) WHERE state = 'REQUESTED';
ALTER TABLE order_item_cancellation_request ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON order_item_cancellation_request TO gphkm_runtime;
REVOKE INSERT, UPDATE, DELETE ON order_item_cancellation_request FROM gphkm_runtime;

CREATE POLICY order_item_cancellation_customer_read ON order_item_cancellation_request FOR SELECT TO gphkm_runtime USING (
  organization_id = nullif(current_setting('app.organization_id', true), '')
  AND public.gphkm_customer_can_read_order_item(order_item_id,
    nullif(current_setting('app.user_id', true), ''), nullif(current_setting('app.organization_id', true), ''))
);
CREATE POLICY order_item_cancellation_assigned_staff_read ON order_item_cancellation_request FOR SELECT TO gphkm_runtime USING (
  public.gphkm_staff_can_read_order_item(order_item_id, nullif(current_setting('app.user_id', true), ''))
);

CREATE FUNCTION public.gphkm_customer_can_request_item_cancellation(target_item_id text, target_user_id text, target_org_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.gphkm_customer_can_read_order_item(target_item_id, target_user_id, target_org_id)
    AND EXISTS (SELECT 1 FROM public.customer_order_item i JOIN public.customer_order o ON o.id = i.order_id
      JOIN public.order_item_fulfillment f ON f.order_item_id = i.id
      WHERE i.id = target_item_id AND o.organization_id = target_org_id AND o.checkout_state = 'PAID'
        AND f.state IN ('CONFIRMED','CONTENT_PREPARATION','AWAITING_CUSTOMER_APPROVAL','READY_FOR_HANDOFF','HANDOFF_PENDING')
        AND f.handed_off_at IS NULL AND f.work_started_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM public.supplier_packet_item pi JOIN public.supplier_packet_attempt a ON a.packet_id = pi.packet_id
      WHERE pi.order_item_id = target_item_id AND a.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERED','DELIVERY_ISSUE','MANUAL_SENT'))
$$;
REVOKE ALL ON FUNCTION public.gphkm_customer_can_request_item_cancellation(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_customer_can_request_item_cancellation(text,text,text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_request_order_item_cancellation(
  target_item_id text, request_id text, request_idempotency_key text, request_digest text, request_reason text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  org_id text := nullif(current_setting('app.organization_id', true), '');
  item_order_id text;
  item_actor_id text;
  request_org_id text;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
  prior public.order_item_cancellation_request%ROWTYPE;
  active_request_id text;
BEGIN
  IF actor_id IS NULL OR org_id IS NULL OR request_id IS NULL OR request_id !~ '^[0-9a-f-]{36}$'
    OR request_idempotency_key IS NULL OR length(request_idempotency_key) NOT BETWEEN 16 AND 128
    OR request_digest IS NULL OR request_digest !~ '^[0-9a-f]{64}$'
    OR request_reason IS NULL OR length(trim(request_reason)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'invalid cancellation request' USING ERRCODE = '22023';
  END IF;
  SELECT o.id, o.actor_user_id, o.organization_id INTO item_order_id, item_actor_id, request_org_id
    FROM public.customer_order_item i JOIN public.customer_order o ON o.id = i.order_id
   WHERE i.id = target_item_id AND o.checkout_state = 'PAID';
  IF NOT FOUND OR request_org_id <> org_id OR NOT public.gphkm_is_active_org_member(org_id, actor_id)
    OR (item_actor_id <> actor_id AND NOT public.gphkm_is_active_org_owner(org_id, actor_id)) THEN
    RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment WHERE order_item_id = target_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order item unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO prior FROM public.order_item_cancellation_request
   WHERE organization_id = org_id AND requested_by_user_id = actor_id AND idempotency_key = request_idempotency_key;
  IF FOUND THEN
    IF prior.request_hash <> request_digest OR prior.order_item_id <> target_item_id THEN
      RAISE EXCEPTION 'cancellation idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN prior.id;
  END IF;
  IF fulfillment_row.state NOT IN ('CONFIRMED','CONTENT_PREPARATION','AWAITING_CUSTOMER_APPROVAL','READY_FOR_HANDOFF','HANDOFF_PENDING')
    OR fulfillment_row.state = 'CANCELLATION_REQUESTED'
    OR fulfillment_row.handed_off_at IS NOT NULL OR fulfillment_row.work_started_at IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM public.supplier_packet_item pi JOIN public.supplier_packet_attempt a ON a.packet_id = pi.packet_id
       WHERE pi.order_item_id = target_item_id AND a.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERED','DELIVERY_ISSUE','MANUAL_SENT')
    ) THEN
    RAISE EXCEPTION 'ordinary cancellation is unavailable after handoff or work start' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO active_request_id FROM public.order_item_cancellation_request
   WHERE order_item_id = target_item_id AND state = 'REQUESTED' FOR UPDATE;
  IF FOUND THEN RAISE EXCEPTION 'cancellation request already pending' USING ERRCODE = '23505'; END IF;
  INSERT INTO public.order_item_cancellation_request(
    id, organization_id, order_id, order_item_id, requested_by_user_id, reason, idempotency_key, request_hash
  ) VALUES (request_id, org_id, item_order_id, target_item_id, actor_id, trim(request_reason), request_idempotency_key, request_digest);
  UPDATE public.order_item_fulfillment SET state_before_cancellation = state, state = 'CANCELLATION_REQUESTED', updated_at = now()
   WHERE order_item_id = target_item_id;
  RETURN request_id;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_request_order_item_cancellation(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_request_order_item_cancellation(text,text,text,text,text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_decide_order_item_cancellation(
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
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment WHERE order_item_id = request_row.order_item_id FOR UPDATE;
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
  IF previous_state IS NULL OR previous_state NOT IN ('CONFIRMED','CONTENT_PREPARATION','AWAITING_CUSTOMER_APPROVAL','READY_FOR_HANDOFF','HANDOFF_PENDING') THEN
    RAISE EXCEPTION 'cancellation state cannot be restored safely' USING ERRCODE = '23514';
  END IF;
  IF target_decision = 'DENIED' THEN
    UPDATE public.order_item_fulfillment SET state = previous_state, state_before_cancellation = NULL, updated_at = now()
     WHERE order_item_id = request_row.order_item_id;
    UPDATE public.order_item_cancellation_request SET state = 'DENIED', decision_by_user_id = actor_id,
      decision_reason = trim(target_decision_reason), decided_at = now() WHERE id = request_row.id;
    RETURN QUERY SELECT request_row.id, 'DENIED'::text, 0::numeric, NULL::text, request_row.organization_id, request_row.order_item_id, true;
    RETURN;
  END IF;

  refund_value := item_row.placement_price_minor;
  IF item_row.writing_selected THEN
    SELECT * INTO writing_row FROM public.order_item_writing WHERE order_item_id = item_row.id FOR UPDATE;
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
  UPDATE public.order_item_fulfillment SET state = 'CANCELED_REFUNDED', state_before_cancellation = NULL,
    customer_status = 'RESOLVED', updated_at = now() WHERE order_item_id = request_row.order_item_id;
  UPDATE public.order_item_cancellation_request SET state = 'APPROVED', decision_by_user_id = actor_id,
    decision_reason = trim(target_decision_reason), refund_minor = refund_value,
    wallet_ledger_entry_id = ledger_entry_id, decided_at = now() WHERE id = request_row.id;
  RETURN QUERY SELECT request_row.id, 'APPROVED'::text, refund_value, ledger_entry_id,
    request_row.organization_id, request_row.order_item_id, true;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_decide_order_item_cancellation(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_decide_order_item_cancellation(text,text,text) TO gphkm_runtime;
