CREATE TABLE public.customer_newsletter_consent_event (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.auth_user(id),
  state text NOT NULL CHECK (state IN ('SUBSCRIBED','UNSUBSCRIBED')),
  notice_version text NOT NULL CHECK (length(notice_version) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id ~ '^[0-9a-f-]{36}$')
);
CREATE INDEX customer_newsletter_consent_user_created_idx
  ON public.customer_newsletter_consent_event(user_id, created_at, id);
ALTER TABLE public.customer_newsletter_consent_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_newsletter_consent_event FROM PUBLIC, gphkm_runtime;
GRANT SELECT ON public.customer_newsletter_consent_event TO gphkm_runtime;
CREATE POLICY customer_newsletter_consent_self_read
  ON public.customer_newsletter_consent_event FOR SELECT TO gphkm_runtime
  USING (user_id = nullif(current_setting('app.user_id', true), ''));

CREATE FUNCTION public.gphkm_set_customer_newsletter_consent(
  target_event_id text, target_subscribed boolean, target_notice_version text
)
RETURNS TABLE(subscribed boolean, changed boolean, notice_version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  actor_verified boolean;
  previous_state text;
  previous_version text;
  desired_version text;
BEGIN
  IF actor_id IS NULL OR target_event_id IS NULL OR target_event_id !~ '^[0-9a-f-]{36}$' OR target_subscribed IS NULL THEN
    RAISE EXCEPTION 'newsletter preference request invalid' USING ERRCODE = '22023';
  END IF;
  SELECT u.email_verified INTO actor_verified FROM public.auth_user u WHERE u.id = actor_id FOR UPDATE;
  IF actor_verified IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'verified customer required' USING ERRCODE = '42501';
  END IF;
  SELECT e.state, e.notice_version INTO previous_state, previous_version
    FROM public.customer_newsletter_consent_event e WHERE e.user_id = actor_id
    ORDER BY e.created_at DESC, e.id DESC LIMIT 1;

  IF target_subscribed THEN
    IF target_notice_version IS NULL OR target_notice_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$' THEN
      RAISE EXCEPTION 'newsletter notice version unavailable' USING ERRCODE = '22023';
    END IF;
    desired_version := target_notice_version;
    IF previous_state = 'SUBSCRIBED' AND previous_version = desired_version THEN
      RETURN QUERY SELECT true, false, previous_version;
      RETURN;
    END IF;
    INSERT INTO public.customer_newsletter_consent_event(id, user_id, state, notice_version)
      VALUES (target_event_id, actor_id, 'SUBSCRIBED', desired_version);
    RETURN QUERY SELECT true, true, desired_version;
    RETURN;
  END IF;

  IF previous_state IS DISTINCT FROM 'SUBSCRIBED' THEN
    RETURN QUERY SELECT false, false, coalesce(previous_version, '');
    RETURN;
  END IF;
  INSERT INTO public.customer_newsletter_consent_event(id, user_id, state, notice_version)
    VALUES (target_event_id, actor_id, 'UNSUBSCRIBED', previous_version);
  RETURN QUERY SELECT false, true, previous_version;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_set_customer_newsletter_consent(text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_set_customer_newsletter_consent(text, boolean, text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_reject_newsletter_consent_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'newsletter consent history is append-only' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_reject_newsletter_consent_mutation() FROM PUBLIC;
CREATE TRIGGER customer_newsletter_consent_immutable
  BEFORE UPDATE OR DELETE ON public.customer_newsletter_consent_event
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_newsletter_consent_mutation();
