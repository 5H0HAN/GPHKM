-- Limit operational fulfillment writes to the assigned Admin and Super Admin.
-- Queue reads remain intentionally broader and expose operational metadata only.
DROP POLICY order_item_fulfillment_staff_update ON public.order_item_fulfillment;
CREATE POLICY order_item_fulfillment_staff_update ON public.order_item_fulfillment FOR UPDATE TO gphkm_runtime
  USING (
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
    OR (assigned_admin_id = nullif(current_setting('app.user_id', true), '')
      AND public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'ADMIN'))
  ) WITH CHECK (
    public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'SUPER_ADMIN')
    OR (assigned_admin_id = nullif(current_setting('app.user_id', true), '')
      AND public.gphkm_is_active_staff(nullif(current_setting('app.user_id', true), ''), 'ADMIN'))
  );

-- Assignment is a dedicated command so Admins can assign an item without
-- gaining direct authority to change its assignee or mutate another item's row.
CREATE FUNCTION public.gphkm_assign_fulfillment_item(target_item_id text, target_admin_id text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  current_assignee text;
  item_organization_id text;
BEGIN
  IF actor_id IS NULL
     OR NOT (public.gphkm_is_active_staff(actor_id, 'ADMIN')
       OR public.gphkm_is_active_staff(actor_id, 'SUPER_ADMIN'))
     OR target_item_id IS NULL OR target_item_id !~ '^[0-9a-f-]{36}$'
     OR (target_admin_id IS NOT NULL AND target_admin_id !~ '^[0-9a-f-]{36}$') THEN
    RAISE EXCEPTION 'Fulfillment assignment unavailable' USING ERRCODE = '42501';
  END IF;

  IF target_admin_id IS NOT NULL AND NOT public.gphkm_is_active_staff(target_admin_id, 'ADMIN') THEN
    RAISE EXCEPTION 'Choose an active Admin' USING ERRCODE = '23514';
  END IF;

  SELECT fulfillment.assigned_admin_id, customer_order.organization_id
    INTO current_assignee, item_organization_id
    FROM public.order_item_fulfillment fulfillment
    JOIN public.customer_order ON customer_order.id = fulfillment.order_id
   WHERE fulfillment.order_item_id = target_item_id FOR UPDATE OF fulfillment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fulfillment item unavailable' USING ERRCODE = '23514';
  END IF;

  UPDATE public.order_item_fulfillment SET assigned_admin_id = target_admin_id, updated_at = now()
   WHERE order_item_id = target_item_id;
  IF current_assignee IS DISTINCT FROM target_admin_id THEN
    INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
    VALUES (gen_random_uuid()::text, item_organization_id, actor_id, 'FULFILLMENT_ASSIGNMENT_CHANGED',
      'CUSTOMER_ORDER_ITEM', target_item_id, 'ADMIN_ASSIGNMENT',
      jsonb_build_object('previousAssigneeId', current_assignee, 'newAssigneeId', target_admin_id));
  END IF;
  RETURN target_item_id;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_assign_fulfillment_item(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_assign_fulfillment_item(text,text) TO gphkm_runtime;

-- The finance resolver has already verified the current complete Stripe
-- snapshot and made its wallet/case changes atomically. On a new resolution,
-- restore access only when a charge.refunded event is proven to be failed or
-- canceled with no successful refund, no provider loss, and no dispute loss.
-- Preserve the grant's recorded interval; expiry continues to run in UTC.
ALTER FUNCTION public.gphkm_resolve_stripe_reconciliation_case(text,text,text,text)
  RENAME TO gphkm_resolve_stripe_reconciliation_case_before_failed_refund_restore;
REVOKE ALL ON FUNCTION public.gphkm_resolve_stripe_reconciliation_case_before_failed_refund_restore(text,text,text,text)
  FROM PUBLIC, gphkm_runtime;

CREATE FUNCTION public.gphkm_resolve_stripe_reconciliation_case(
  target_attempt_id text, target_snapshot_id text, target_evidence_reference text, target_reason text
) RETURNS TABLE(provider_loss_minor numeric, wallet_recovery_minor numeric, uncovered_minor numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  target_organization_id text;
  prior public.stripe_reconciliation_decision%ROWTYPE;
  result_provider_loss numeric;
  result_wallet_recovery numeric;
  result_uncovered numeric;
  snapshot_facts jsonb;
  refund_proven_failed_or_canceled boolean;
  no_successful_refund boolean;
  no_lost_dispute boolean;
  restored_grant_id text;
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'FINANCE') THEN
    RAISE EXCEPTION 'Stripe reconciliation unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT organization_id INTO target_organization_id FROM public.payment_attempt
   WHERE id = target_attempt_id AND provider = 'STRIPE';
  IF target_organization_id IS NULL THEN
    RAISE EXCEPTION 'Stripe funding attempt unavailable' USING ERRCODE = '23514';
  END IF;

  -- Keep the same lock order as Stripe event ingestion and all existing Finance
  -- resolution paths: organization risk advisory lock, then payment attempt.
  PERFORM pg_advisory_xact_lock(hashtextextended('gphkm:wallet-risk:' || target_organization_id, 0));
  PERFORM 1 FROM public.payment_attempt
   WHERE id = target_attempt_id AND provider = 'STRIPE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stripe funding attempt unavailable' USING ERRCODE = '23514'; END IF;

  SELECT d.* INTO prior FROM public.stripe_reconciliation_decision d
    JOIN public.stripe_reconciliation_case c ON c.id = d.case_id
   WHERE c.payment_attempt_id = target_attempt_id AND d.snapshot_id = target_snapshot_id;
  IF FOUND THEN
    IF prior.actor_user_id <> actor_id
       OR prior.evidence_reference <> btrim(target_evidence_reference)
       OR prior.reason <> btrim(target_reason) THEN
      RAISE EXCEPTION 'This Stripe snapshot already has a different Finance decision' USING ERRCODE = '23505';
    END IF;
    -- Prior success and access restoration committed in one transaction. A
    -- same-request retry returns the immutable decision and never audits twice.
    RETURN QUERY SELECT prior.provider_loss_minor, prior.wallet_recovery_minor, prior.uncovered_minor;
    RETURN;
  END IF;

  SELECT facts INTO snapshot_facts FROM public.stripe_finance_snapshot
   WHERE id = target_snapshot_id AND payment_attempt_id = target_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current Stripe snapshot is unavailable' USING ERRCODE = '23514'; END IF;

  SELECT d.provider_loss_minor, d.wallet_recovery_minor, d.uncovered_minor
    INTO result_provider_loss, result_wallet_recovery, result_uncovered
    FROM public.gphkm_resolve_stripe_reconciliation_case_before_failed_refund_restore(
      target_attempt_id, target_snapshot_id, target_evidence_reference, target_reason) d;

  SELECT EXISTS (
      SELECT 1 FROM public.provider_event e
       WHERE e.payment_attempt_id = target_attempt_id AND e.event_type = 'charge.refunded'
    ) AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(snapshot_facts->'refunds') refund
       WHERE refund->>'status' IN ('failed', 'canceled')
    ),
    NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(snapshot_facts->'refunds') refund
       WHERE refund->>'status' = 'succeeded'
    ),
    NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(snapshot_facts->'disputes') dispute
       WHERE dispute->>'status' IN ('lost', 'warning_needs_response', 'warning_under_review')
    )
    INTO refund_proven_failed_or_canceled, no_successful_refund, no_lost_dispute;

  IF result_provider_loss = 0 AND result_uncovered = 0
     AND refund_proven_failed_or_canceled AND no_successful_refund AND no_lost_dispute THEN
    UPDATE public.payment_attempt SET state = 'SETTLED', updated_at = now()
     WHERE id = target_attempt_id AND provider = 'STRIPE' AND state = 'REVERSED';

    UPDATE public.access_grant g SET state = 'ACTIVE', suspension_reason = NULL, updated_at = now()
      FROM public.wallet_ledger_entry l
     WHERE l.organization_id = target_organization_id AND l.operation = 'STRIPE_TOP_UP'
       AND l.idempotency_key = target_attempt_id
       AND g.ledger_entry_id = l.id AND g.organization_id = target_organization_id
       AND g.state = 'REVOKED' AND g.suspension_reason = 'STRIPE_REVERSAL'
     RETURNING g.id INTO restored_grant_id;

    IF restored_grant_id IS NOT NULL THEN
      INSERT INTO public.audit_event(id, organization_id, actor_user_id, action, target_type, target_id, reason_code, metadata)
      VALUES (gen_random_uuid()::text, target_organization_id, actor_id,
        'STRIPE_FAILED_REFUND_ACCESS_RESTORED', 'ACCESS_GRANT', restored_grant_id,
        'PROVIDER_CONFIRMED_FAILED_OR_CANCELED_REFUND',
        jsonb_build_object('paymentAttemptId', target_attempt_id, 'snapshotId', target_snapshot_id,
          'intervalPreserved', true, 'providerLossMinor', result_provider_loss::text));
    END IF;
  END IF;

  RETURN QUERY SELECT result_provider_loss, result_wallet_recovery, result_uncovered;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_resolve_stripe_reconciliation_case(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_resolve_stripe_reconciliation_case(text,text,text,text) TO gphkm_runtime;

-- Evaluate the consent cutoff from the row version obtained by FOR UPDATE.
-- A STABLE SQL helper can keep the INSERT statement's old snapshot after this
-- lock waits for a concurrent handoff commit, so it must not decide this race.
CREATE OR REPLACE FUNCTION public.gphkm_validate_content_change_event_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  version_row public.order_item_content_version%ROWTYPE;
  request_item text;
  fulfillment_row public.order_item_fulfillment%ROWTYPE;
BEGIN
  IF NEW.event_type IN ('APPROVED','CONSENTED') THEN
    IF NEW.version_id IS NULL THEN RAISE EXCEPTION 'approved content event requires a version' USING ERRCODE = '23514'; END IF;
    SELECT * INTO version_row FROM public.order_item_content_version v
     WHERE v.id = NEW.version_id AND v.request_id = NEW.request_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'content version does not belong to request' USING ERRCODE = '23514'; END IF;
    IF NEW.content_hash IS DISTINCT FROM version_row.content_hash THEN
      RAISE EXCEPTION 'event hash does not match bound content, supplier and recipient' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.event_type = 'CONSENTED' THEN
    SELECT r.order_item_id INTO request_item FROM public.order_item_content_change_request r WHERE r.id = NEW.request_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'content request unavailable' USING ERRCODE = '23514'; END IF;
    SELECT * INTO fulfillment_row FROM public.order_item_fulfillment f
     WHERE f.order_item_id = request_item FOR UPDATE;
    IF NOT FOUND OR fulfillment_row.handed_off_at IS NOT NULL OR fulfillment_row.state IN (
      'IN_FULFILLMENT','PUBLICATION_PENDING','EVIDENCE_REVIEW','COMPLETED','CANCELED_REFUNDED','CANCELLATION_REQUESTED'
    ) OR EXISTS (
      SELECT 1 FROM public.supplier_packet_item pi
      JOIN public.supplier_packet_attempt a ON a.packet_id = pi.packet_id
      WHERE pi.order_item_id = request_item
        AND a.state IN ('SENDING','UNKNOWN','ACCEPTED','DELIVERED','DELIVERY_ISSUE','MANUAL_SENT')
    ) THEN
      RAISE EXCEPTION 'content consent closes after handoff' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Partial index for the per-item refund subquery used by reconciliation.
CREATE INDEX wallet_ledger_item_refund_lookup_idx
  ON public.wallet_ledger_entry (organization_id, related_id)
  WHERE kind = 'ITEM_REFUND' AND related_type = 'CUSTOMER_ORDER_ITEM';
