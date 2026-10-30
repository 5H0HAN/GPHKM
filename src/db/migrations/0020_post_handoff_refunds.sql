-- Finance/Super Admin approved, case-linked post-cutoff wallet refunds.
ALTER TABLE support_case_event DROP CONSTRAINT support_case_event_decision_check;
ALTER TABLE support_case_event ADD CONSTRAINT support_case_event_decision_check
  CHECK (decision IS NULL OR decision IN ('APPROVED', 'DENIED', 'MORE_INFORMATION_REQUIRED'));

CREATE TABLE post_handoff_refund_request (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id),
  case_id text NOT NULL REFERENCES support_case(id),
  order_id text NOT NULL REFERENCES customer_order(id),
  order_item_id text NOT NULL REFERENCES customer_order_item(id),
  request_number integer NOT NULL CHECK (request_number > 0),
  requested_by_user_id text NOT NULL REFERENCES auth_user(id),
  requested_amount_minor numeric(20,0) NOT NULL CHECK (requested_amount_minor > 0),
  request_reason text NOT NULL CHECK (length(btrim(request_reason)) BETWEEN 5 AND 2000),
  request_idempotency_key text NOT NULL CHECK (length(request_idempotency_key) BETWEEN 16 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED','APPROVED','DENIED')),
  decision_by_user_id text REFERENCES auth_user(id),
  decision_reason text,
  refund_minor numeric(20,0) NOT NULL DEFAULT 0 CHECK (refund_minor >= 0),
  wallet_ledger_entry_id text REFERENCES wallet_ledger_entry(id),
  decision_idempotency_key text CHECK (decision_idempotency_key IS NULL OR length(decision_idempotency_key) BETWEEN 16 AND 128),
  decision_hash text CHECK (decision_hash IS NULL OR decision_hash ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT post_handoff_refund_request_number_uq UNIQUE (case_id, request_number),
  CONSTRAINT post_handoff_refund_request_idempotency_uq UNIQUE (organization_id, requested_by_user_id, request_idempotency_key),
  CONSTRAINT post_handoff_refund_decision_shape CHECK (
    (state = 'REQUESTED' AND decision_by_user_id IS NULL AND decision_reason IS NULL AND decided_at IS NULL AND refund_minor = 0 AND wallet_ledger_entry_id IS NULL AND decision_idempotency_key IS NULL AND decision_hash IS NULL)
    OR (state = 'DENIED' AND decision_by_user_id IS NOT NULL AND decision_reason IS NOT NULL AND decided_at IS NOT NULL AND refund_minor = 0 AND wallet_ledger_entry_id IS NULL AND decision_idempotency_key IS NOT NULL AND decision_hash IS NOT NULL)
    OR (state = 'APPROVED' AND decision_by_user_id IS NOT NULL AND decision_reason IS NOT NULL AND decided_at IS NOT NULL AND refund_minor > 0 AND wallet_ledger_entry_id IS NOT NULL AND decision_idempotency_key IS NOT NULL AND decision_hash IS NOT NULL)
  )
);
CREATE UNIQUE INDEX post_handoff_refund_one_pending_per_case_uq ON post_handoff_refund_request(case_id) WHERE state = 'REQUESTED';
CREATE INDEX post_handoff_refund_case_state_idx ON post_handoff_refund_request(case_id, state, requested_at);
CREATE INDEX post_handoff_refund_org_state_idx ON post_handoff_refund_request(organization_id, state, requested_at);
ALTER TABLE post_handoff_refund_request ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON post_handoff_refund_request TO gphkm_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON post_handoff_refund_request FROM gphkm_runtime;

CREATE POLICY post_handoff_refund_admin_read ON post_handoff_refund_request FOR SELECT TO gphkm_runtime USING (
  public.gphkm_support_admin_access(case_id, nullif(current_setting('app.user_id', true), ''))
);
CREATE POLICY post_handoff_refund_finance_read ON post_handoff_refund_request FOR SELECT TO gphkm_runtime USING (
  public.gphkm_support_finance_access(case_id, nullif(current_setting('app.user_id', true), ''))
  OR (decision_by_user_id = nullif(current_setting('app.user_id', true), '')
    AND public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE'))
  OR public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
);
CREATE POLICY support_event_finance_decision_author_read ON support_case_event FOR SELECT TO gphkm_runtime USING (
  audience = 'FINANCE' AND actor_user_id = nullif(current_setting('app.user_id', true), '')
  AND public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'FINANCE')
);

CREATE FUNCTION public.gphkm_reject_post_handoff_refund_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'post-handoff refund records are immutable except through decision function' USING ERRCODE = '42501'; END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_post_handoff_refund_mutation() FROM PUBLIC;
CREATE TRIGGER post_handoff_refund_append_only BEFORE DELETE ON post_handoff_refund_request
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_post_handoff_refund_mutation();

CREATE FUNCTION public.gphkm_validate_post_handoff_refund_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.id, NEW.organization_id, NEW.case_id, NEW.order_id, NEW.order_item_id, NEW.request_number,
      NEW.requested_by_user_id, NEW.requested_amount_minor, NEW.request_reason, NEW.request_idempotency_key,
      NEW.request_hash, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.case_id, OLD.order_id, OLD.order_item_id, OLD.request_number,
      OLD.requested_by_user_id, OLD.requested_amount_minor, OLD.request_reason, OLD.request_idempotency_key,
      OLD.request_hash, OLD.requested_at)
     OR OLD.state <> 'REQUESTED' OR NEW.state NOT IN ('APPROVED', 'DENIED') THEN
    RAISE EXCEPTION 'post-handoff refund request is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_validate_post_handoff_refund_update() FROM PUBLIC;
CREATE TRIGGER post_handoff_refund_update_guard BEFORE UPDATE ON post_handoff_refund_request
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_validate_post_handoff_refund_update();

CREATE FUNCTION public.gphkm_request_post_handoff_refund(
  target_request_id text, target_case_id text, target_idempotency_key text,
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
  IF actor_id IS NULL OR target_request_id !~ '^[0-9a-f-]{36}$' OR target_case_id !~ '^[0-9a-f-]{36}$'
    OR target_idempotency_key IS NULL OR length(target_idempotency_key) NOT BETWEEN 16 AND 128
    OR target_request_hash IS NULL OR target_request_hash !~ '^[0-9a-f]{64}$'
    OR target_amount IS NULL OR target_amount <= 0
    OR target_reason IS NULL OR length(btrim(target_reason)) NOT BETWEEN 5 AND 2000
    OR NOT (public.gphkm_is_active_staff(actor_id, 'ADMIN') OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')) THEN
    RAISE EXCEPTION 'post-handoff refund request unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO case_row FROM public.support_case WHERE id = target_case_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'case unavailable' USING ERRCODE = '23514'; END IF;
  IF public.gphkm_is_active_staff(actor_id, 'ADMIN') AND NOT public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN')
     AND NOT public.gphkm_support_admin_access(case_row.id, actor_id) THEN
    RAISE EXCEPTION 'assigned Admin required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO existing FROM public.post_handoff_refund_request
   WHERE organization_id = case_row.organization_id AND requested_by_user_id = actor_id AND request_idempotency_key = target_idempotency_key;
  IF FOUND THEN
    IF existing.request_hash <> target_request_hash OR existing.case_id <> case_row.id THEN
      RAISE EXCEPTION 'refund request idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing.id, existing.state, existing.requested_amount_minor, existing.organization_id, existing.order_item_id, false;
    RETURN;
  END IF;
  IF case_row.state <> 'FINANCE_REVIEW' THEN
    RAISE EXCEPTION 'case must be in Finance Review' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO order_row FROM public.customer_order WHERE id = case_row.order_id AND checkout_state = 'PAID';
  SELECT * INTO item_row FROM public.customer_order_item WHERE id = case_row.order_item_id AND order_id = case_row.order_id;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment WHERE order_item_id = case_row.order_item_id FOR UPDATE;
  IF order_row.id IS NULL OR item_row.id IS NULL OR fulfillment_row.order_item_id IS NULL
    OR order_row.organization_id <> case_row.organization_id
    OR (fulfillment_row.handed_off_at IS NULL AND fulfillment_row.work_started_at IS NULL)
    OR fulfillment_row.state IN ('COMPLETED', 'CANCELED_REFUNDED') THEN
    RAISE EXCEPTION 'item is not eligible for a post-handoff exception' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.wallet_account WHERE organization_id = case_row.organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet unavailable' USING ERRCODE = '23514'; END IF;
  captured := item_row.placement_price_minor + item_row.writing_price_minor;
  IF item_row.writing_selected THEN
    IF NOT EXISTS (SELECT 1 FROM public.order_item_writing w WHERE w.order_item_id = item_row.id AND w.state IN ('APPROVED_FIRST','APPROVED_FINAL')) THEN
      RAISE EXCEPTION 'writing service is not complete' USING ERRCODE = '23514';
    END IF;
    captured := item_row.placement_price_minor;
  END IF;
  SELECT coalesce(sum(delta_minor), 0) INTO refunded FROM public.wallet_ledger_entry
   WHERE organization_id = case_row.organization_id AND kind = 'ITEM_REFUND'
     AND related_type = 'CUSTOMER_ORDER_ITEM' AND related_id = case_row.order_item_id;
  IF target_amount > captured - refunded THEN
    RAISE EXCEPTION 'requested refund exceeds remaining item charge' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(max(request_number), 0) + 1 INTO next_number FROM public.post_handoff_refund_request WHERE case_id = case_row.id;
  INSERT INTO public.post_handoff_refund_request(id, organization_id, case_id, order_id, order_item_id, request_number,
    requested_by_user_id, requested_amount_minor, request_reason, request_idempotency_key, request_hash)
  VALUES (target_request_id, case_row.organization_id, case_row.id, case_row.order_id, case_row.order_item_id, next_number,
    actor_id, target_amount, btrim(target_reason), target_idempotency_key, target_request_hash);
  INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
  VALUES (gen_random_uuid()::text, case_row.organization_id, actor_id, 'POST_HANDOFF_REFUND_REQUESTED',
    'SUPPORT_CASE', case_row.id, 'POST_HANDOFF_EXCEPTION', jsonb_build_object('result', 'REQUESTED', 'amountMinor', target_amount::text));
  RETURN QUERY SELECT target_request_id, 'REQUESTED'::text, target_amount, case_row.organization_id, case_row.order_item_id, true;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_request_post_handoff_refund(text,text,text,text,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_request_post_handoff_refund(text,text,text,text,numeric,text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_decide_post_handoff_refund(
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
  SELECT * INTO case_row FROM public.support_case WHERE id = request_row.case_id FOR UPDATE;
  IF NOT FOUND OR case_row.organization_id <> request_row.organization_id OR case_row.order_item_id <> request_row.order_item_id THEN
    RAISE EXCEPTION 'case unavailable' USING ERRCODE = '23514';
  END IF;
  IF request_row.state <> 'REQUESTED' THEN
    IF request_row.decision_idempotency_key = target_decision_idempotency_key
      AND request_row.decision_hash = target_decision_hash THEN
      RETURN QUERY SELECT request_row.id, request_row.state, request_row.refund_minor, request_row.wallet_ledger_entry_id,
        request_row.organization_id, request_row.case_id, request_row.order_item_id, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'refund request already decided' USING ERRCODE = '23514';
  END IF;
  IF case_row.state <> 'FINANCE_REVIEW' THEN
    RAISE EXCEPTION 'case is not in Finance Review' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO item_row FROM public.customer_order_item WHERE id = request_row.order_item_id AND order_id = request_row.order_id;
  SELECT * INTO fulfillment_row FROM public.order_item_fulfillment WHERE order_item_id = request_row.order_item_id FOR UPDATE;
  IF item_row.id IS NULL OR fulfillment_row.order_item_id IS NULL
    OR (fulfillment_row.handed_off_at IS NULL AND fulfillment_row.work_started_at IS NULL)
    OR fulfillment_row.state IN ('COMPLETED', 'CANCELED_REFUNDED') THEN
    RAISE EXCEPTION 'item is not eligible for a post-handoff exception' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.wallet_account WHERE organization_id = request_row.organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet unavailable' USING ERRCODE = '23514'; END IF;
  captured := item_row.placement_price_minor + item_row.writing_price_minor;
  IF item_row.writing_selected THEN
    IF NOT EXISTS (SELECT 1 FROM public.order_item_writing w WHERE w.order_item_id = item_row.id AND w.state IN ('APPROVED_FIRST','APPROVED_FINAL')) THEN
      RAISE EXCEPTION 'writing service is not complete' USING ERRCODE = '23514';
    END IF;
    captured := item_row.placement_price_minor;
  END IF;
  SELECT coalesce(sum(delta_minor), 0) INTO refunded FROM public.wallet_ledger_entry
   WHERE organization_id = request_row.organization_id AND kind = 'ITEM_REFUND'
     AND related_type = 'CUSTOMER_ORDER_ITEM' AND related_id = request_row.order_item_id;
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
    UPDATE public.order_item_fulfillment SET state = 'CANCELED_REFUNDED', state_before_cancellation = NULL,
      customer_status = 'RESOLVED', updated_at = clock_timestamp()
     WHERE order_item_id = request_row.order_item_id;
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
REVOKE ALL ON FUNCTION public.gphkm_decide_post_handoff_refund(text,text,numeric,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_decide_post_handoff_refund(text,text,numeric,text,text,text) TO gphkm_runtime;
