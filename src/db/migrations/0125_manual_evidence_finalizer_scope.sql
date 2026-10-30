-- The reservation creator and the staff member who records the actual send may
-- differ. The finalizer must still be authorized for the packet and is recorded
-- by the attempt event and evidence uploader fields.
CREATE OR REPLACE FUNCTION public.gphkm_supplier_packet_manual_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE attempt_row public.supplier_packet_attempt%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.uploaded_by_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '') THEN
    RAISE EXCEPTION 'supplier packet evidence is append-only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO attempt_row FROM public.supplier_packet_attempt
    WHERE id = NEW.attempt_id AND packet_id = NEW.packet_id FOR SHARE;
  IF NOT FOUND OR attempt_row.type NOT IN ('MANUAL_SENT','MANUAL_SEND') OR attempt_row.state <> 'MANUAL_SENT'
     OR attempt_row.sent_at IS NULL OR NOT public.gphkm_supplier_packet_access(NEW.packet_id, NEW.uploaded_by_user_id)
     OR NEW.created_at < attempt_row.created_at - interval '5 minutes'
     OR NEW.created_at > now() + interval '5 minutes'
     OR (NEW.file_kind = 'EML' AND NEW.file_name !~ '\.eml$')
     OR (NEW.file_kind = 'PDF' AND NEW.file_name !~ '\.pdf$') THEN
    RAISE EXCEPTION 'supplier packet evidence does not match an authorized manual send' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
