CREATE TABLE public.supplier_packet_manual_evidence (
  id text PRIMARY KEY,
  packet_id text NOT NULL REFERENCES public.supplier_packet(id),
  attempt_id text NOT NULL UNIQUE REFERENCES public.supplier_packet_attempt(id),
  storage_key text NOT NULL UNIQUE,
  file_kind text NOT NULL CHECK (file_kind IN ('EML','PDF')),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 180 AND file_name !~ '[[:cntrl:]]'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by_user_id text NOT NULL REFERENCES public.auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (storage_key ~ '^[0-9a-f-]{36}$')
);
ALTER TABLE public.supplier_packet_manual_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_packet_manual_evidence FROM PUBLIC;
GRANT SELECT, INSERT ON public.supplier_packet_manual_evidence TO gphkm_runtime;
CREATE INDEX supplier_packet_manual_evidence_packet_idx ON public.supplier_packet_manual_evidence(packet_id, created_at);

CREATE POLICY supplier_packet_manual_evidence_staff_read ON public.supplier_packet_manual_evidence
  FOR SELECT TO gphkm_runtime USING (
    public.gphkm_supplier_packet_access(packet_id, nullif(current_setting('app.user_id', true), ''))
  );
CREATE POLICY supplier_packet_manual_evidence_staff_insert ON public.supplier_packet_manual_evidence
  FOR INSERT TO gphkm_runtime WITH CHECK (
    uploaded_by_user_id = nullif(current_setting('app.user_id', true), '')
    AND public.gphkm_supplier_packet_access(packet_id, uploaded_by_user_id)
    AND (public.gphkm_is_active_staff(uploaded_by_user_id, 'ADMIN') OR public.gphkm_is_active_staff(uploaded_by_user_id, 'SUPER_ADMIN'))
  );

CREATE FUNCTION public.gphkm_supplier_packet_manual_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE attempt_row public.supplier_packet_attempt%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.uploaded_by_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '') THEN
    RAISE EXCEPTION 'supplier packet evidence is append-only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO attempt_row FROM public.supplier_packet_attempt
    WHERE id = NEW.attempt_id AND packet_id = NEW.packet_id FOR SHARE;
  IF NOT FOUND OR attempt_row.type <> 'MANUAL_SENT' OR attempt_row.state <> 'MANUAL_SENT'
     OR attempt_row.sent_at IS NULL OR attempt_row.actor_user_id IS DISTINCT FROM NEW.uploaded_by_user_id
     OR NEW.created_at < attempt_row.created_at - interval '5 minutes'
     OR NEW.created_at > now() + interval '5 minutes'
     OR (NEW.file_kind = 'EML' AND NEW.file_name !~ '\.eml$')
     OR (NEW.file_kind = 'PDF' AND NEW.file_name !~ '\.pdf$') THEN
    RAISE EXCEPTION 'supplier packet evidence does not match a manual send' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_supplier_packet_manual_evidence_guard() FROM PUBLIC;
CREATE TRIGGER supplier_packet_manual_evidence_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.supplier_packet_manual_evidence
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_packet_manual_evidence_guard();
