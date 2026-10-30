-- Customer-safe in-app notifications and durable email intents; no email provider is invoked here.
CREATE TABLE customer_notification (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id),
  recipient_user_id text NOT NULL REFERENCES auth_user(id),
  kind text NOT NULL CHECK (kind IN ('ORDER_MILESTONE','ORDER_ACTION','SUPPORT_UPDATE')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  order_item_id text REFERENCES customer_order_item(id),
  support_case_id text REFERENCES support_case(id),
  source_key text NOT NULL UNIQUE CHECK (length(source_key) BETWEEN 1 AND 200),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('ORDER_MILESTONE','ORDER_ACTION') AND order_item_id IS NOT NULL AND support_case_id IS NULL)
    OR (kind = 'SUPPORT_UPDATE' AND order_item_id IS NULL AND support_case_id IS NOT NULL))
);
CREATE INDEX customer_notification_inbox_idx ON customer_notification(organization_id, recipient_user_id, created_at DESC);
CREATE INDEX customer_notification_unread_idx ON customer_notification(organization_id, recipient_user_id, read_at);
ALTER TABLE customer_notification ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON customer_notification FROM PUBLIC, gphkm_runtime;
GRANT SELECT, UPDATE(read_at) ON customer_notification TO gphkm_runtime;
CREATE POLICY customer_notification_recipient_read ON customer_notification FOR SELECT TO gphkm_runtime USING (
  recipient_user_id = nullif(current_setting('app.user_id', true), '')
  AND organization_id = nullif(current_setting('app.organization_id', true), '')
  AND public.gphkm_is_active_org_member(organization_id, recipient_user_id)
);
CREATE POLICY customer_notification_recipient_mark_read ON customer_notification FOR UPDATE TO gphkm_runtime USING (
  recipient_user_id = nullif(current_setting('app.user_id', true), '')
  AND organization_id = nullif(current_setting('app.organization_id', true), '')
  AND public.gphkm_is_active_org_member(organization_id, recipient_user_id)
) WITH CHECK (
  recipient_user_id = nullif(current_setting('app.user_id', true), '')
  AND organization_id = nullif(current_setting('app.organization_id', true), '')
  AND public.gphkm_is_active_org_member(organization_id, recipient_user_id)
);

CREATE TABLE customer_notification_email_outbox (
  id text PRIMARY KEY,
  notification_id text NOT NULL UNIQUE REFERENCES customer_notification(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE customer_notification_email_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON customer_notification_email_outbox FROM PUBLIC, gphkm_runtime;

CREATE FUNCTION public.gphkm_enqueue_customer_notification(
  target_organization_id text, target_user_id text, target_kind text, target_title text,
  target_body text, target_order_item_id text, target_support_case_id text, target_source_key text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE notification_id text;
BEGIN
  IF target_kind NOT IN ('ORDER_MILESTONE','ORDER_ACTION','SUPPORT_UPDATE') OR target_title IS NULL OR length(target_title) NOT BETWEEN 1 AND 120
    OR target_body IS NULL OR length(target_body) NOT BETWEEN 1 AND 500 OR target_source_key IS NULL
    OR length(target_source_key) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid notification event' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.customer_notification(id, organization_id, recipient_user_id, kind, title, body,
    order_item_id, support_case_id, source_key)
  VALUES (gen_random_uuid()::text, target_organization_id, target_user_id, target_kind, target_title,
    target_body, target_order_item_id, target_support_case_id, target_source_key)
  ON CONFLICT (source_key) DO NOTHING
  RETURNING id INTO notification_id;
  IF notification_id IS NOT NULL THEN
    INSERT INTO public.customer_notification_email_outbox(id, notification_id)
    VALUES (gen_random_uuid()::text, notification_id);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_enqueue_customer_notification(text,text,text,text,text,text,text,text) FROM PUBLIC, gphkm_runtime;

CREATE FUNCTION public.gphkm_order_notification_after_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_id text; customer_id text; title_value text; body_value text; source text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.customer_status IS NOT DISTINCT FROM OLD.customer_status THEN RETURN NEW; END IF;
  END IF;
  SELECT o.organization_id, o.actor_user_id INTO org_id, customer_id
    FROM public.customer_order o WHERE o.id = NEW.order_id;
  IF org_id IS NULL OR customer_id IS NULL THEN RETURN NEW; END IF;
  CASE NEW.customer_status
    WHEN 'ORDER_RECEIVED' THEN title_value := 'Order received'; body_value := 'Your placement is in the order queue.';
    WHEN 'CONTENT_REVIEW' THEN title_value := 'Content review'; body_value := 'GPHKM is reviewing your content.';
    WHEN 'PREPARING' THEN title_value := 'Preparing your placement'; body_value := 'GPHKM is preparing your placement.';
    WHEN 'IN_PROGRESS' THEN title_value := 'Publication in progress'; body_value := 'Your placement is moving forward.';
    WHEN 'LINK_VERIFICATION' THEN title_value := 'Link verification'; body_value := 'GPHKM is checking the live placement.';
    WHEN 'COMPLETE' THEN title_value := 'Placement complete'; body_value := 'Your placement has been verified.';
    WHEN 'RESOLVED' THEN title_value := 'Placement resolved'; body_value := 'Your placement request has been resolved.';
    ELSE RETURN NEW;
  END CASE;
  source := 'order:' || NEW.order_item_id || ':' || NEW.customer_status || ':' || to_char(NEW.updated_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS');
  PERFORM public.gphkm_enqueue_customer_notification(org_id, customer_id, 'ORDER_MILESTONE', title_value,
    body_value, NEW.order_item_id, NULL, source);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_order_notification_after_change() FROM PUBLIC;
CREATE TRIGGER customer_order_notification_after_insert
  AFTER INSERT ON order_item_fulfillment FOR EACH ROW EXECUTE FUNCTION public.gphkm_order_notification_after_change();
CREATE TRIGGER customer_order_notification_after_status
  AFTER UPDATE OF customer_status ON order_item_fulfillment FOR EACH ROW EXECUTE FUNCTION public.gphkm_order_notification_after_change();

CREATE FUNCTION public.gphkm_writing_action_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_id text; customer_id text; title_value text; body_value text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;
  IF NEW.state = 'FIRST_DRAFT_READY' THEN
    title_value := 'Writing draft ready'; body_value := 'Review the draft to continue your order.';
  ELSIF NEW.state = 'FINAL_DRAFT_READY' THEN
    title_value := 'Final writing draft ready'; body_value := 'Review the final draft to continue your order.';
  ELSE
    RETURN NEW;
  END IF;
  SELECT o.organization_id, o.actor_user_id INTO org_id, customer_id
    FROM public.customer_order_item i JOIN public.customer_order o ON o.id = i.order_id
    WHERE i.id = NEW.order_item_id;
  IF org_id IS NULL OR customer_id IS NULL THEN RETURN NEW; END IF;
  PERFORM public.gphkm_enqueue_customer_notification(org_id, customer_id, 'ORDER_ACTION', title_value, body_value,
    NEW.order_item_id, NULL, 'writing:' || NEW.order_item_id || ':' || NEW.state || ':' || to_char(NEW.updated_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS'));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_writing_action_notification() FROM PUBLIC;
CREATE TRIGGER customer_writing_action_notification_after_insert
  AFTER INSERT ON order_item_writing FOR EACH ROW EXECUTE FUNCTION public.gphkm_writing_action_notification();
CREATE TRIGGER customer_writing_action_notification_after_state
  AFTER UPDATE OF state ON order_item_writing FOR EACH ROW EXECUTE FUNCTION public.gphkm_writing_action_notification();

CREATE FUNCTION public.gphkm_content_change_action_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_id text; customer_id text;
BEGIN
  IF NEW.event_type <> 'APPROVED' THEN RETURN NEW; END IF;
  SELECT o.organization_id, o.actor_user_id INTO org_id, customer_id
    FROM public.order_item_content_change_request r
    JOIN public.customer_order_item i ON i.id = r.order_item_id
    JOIN public.customer_order o ON o.id = i.order_id
    WHERE r.id = NEW.request_id;
  IF org_id IS NULL OR customer_id IS NULL THEN RETURN NEW; END IF;
  PERFORM public.gphkm_enqueue_customer_notification(org_id, customer_id, 'ORDER_ACTION',
    'Content change ready for approval', 'Review and approve the updated placement details to continue.',
    (SELECT r.order_item_id FROM public.order_item_content_change_request r WHERE r.id = NEW.request_id), NULL,
    'content-change:' || NEW.request_id || ':' || coalesce(NEW.version_id, NEW.id));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_content_change_action_notification() FROM PUBLIC;
CREATE TRIGGER customer_content_change_action_notification
  AFTER INSERT ON order_item_content_change_event FOR EACH ROW EXECUTE FUNCTION public.gphkm_content_change_action_notification();

CREATE FUNCTION public.gphkm_cancellation_action_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE title_value text; body_value text;
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  IF NEW.state = 'APPROVED' THEN
    title_value := 'Cancellation reviewed'; body_value := 'Review the order item to see the decision and any wallet credit.';
  ELSIF NEW.state = 'DENIED' THEN
    title_value := 'Cancellation reviewed'; body_value := 'Review the order item for the decision or contact Support.';
  ELSE
    RETURN NEW;
  END IF;
  PERFORM public.gphkm_enqueue_customer_notification(NEW.organization_id, NEW.requested_by_user_id, 'ORDER_ACTION',
    title_value, body_value, NEW.order_item_id, NULL,
    'cancellation:' || NEW.id || ':' || NEW.state || ':' || to_char(NEW.decided_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS'));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_cancellation_action_notification() FROM PUBLIC;
CREATE TRIGGER customer_cancellation_action_notification
  AFTER UPDATE OF state ON order_item_cancellation_request FOR EACH ROW EXECUTE FUNCTION public.gphkm_cancellation_action_notification();

CREATE FUNCTION public.gphkm_support_notification_after_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_id text; customer_id text; title_value text; body_value text;
BEGIN
  IF NEW.actor_kind <> 'STAFF' THEN RETURN NEW; END IF;
  SELECT c.organization_id, c.opened_by_user_id INTO org_id, customer_id
    FROM public.support_case c WHERE c.id = NEW.case_id;
  IF org_id IS NULL OR customer_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.kind = 'REPLY' AND NEW.audience = 'CUSTOMER' THEN
    title_value := 'Support replied'; body_value := 'GPHKM sent an update to your Support request.';
  ELSIF NEW.kind = 'STATE_CHANGED' AND NEW.audience = 'INTERNAL' THEN
    CASE NEW.to_state
      WHEN 'OPEN' THEN title_value := 'Support request received'; body_value := 'GPHKM received your Support request.';
      WHEN 'INVESTIGATING' THEN title_value := 'Support request in review'; body_value := 'GPHKM is reviewing your Support request.';
      WHEN 'WAITING_ON_CUSTOMER' THEN title_value := 'Support needs your reply'; body_value := 'GPHKM is waiting for information from you.';
      WHEN 'WAITING_ON_SUPPLIER' THEN title_value := 'Support request in review'; body_value := 'GPHKM is reviewing your Support request.';
      WHEN 'FINANCE_REVIEW' THEN title_value := 'Support request in review'; body_value := 'GPHKM is reviewing your Support request.';
      WHEN 'RESOLVED' THEN title_value := 'Support request resolved'; body_value := 'GPHKM resolved your Support request.';
      WHEN 'CLOSED' THEN title_value := 'Support request resolved'; body_value := 'GPHKM closed your Support request.';
      ELSE RETURN NEW;
    END CASE;
  ELSE
    RETURN NEW;
  END IF;
  PERFORM public.gphkm_enqueue_customer_notification(org_id, customer_id, 'SUPPORT_UPDATE', title_value,
    body_value, NULL, NEW.case_id, 'support-event:' || NEW.id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_support_notification_after_event() FROM PUBLIC;
CREATE TRIGGER customer_support_notification_after_event
  AFTER INSERT ON support_case_event FOR EACH ROW EXECUTE FUNCTION public.gphkm_support_notification_after_event();
