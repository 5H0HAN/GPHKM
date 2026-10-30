ALTER TABLE "supplier_packet_acknowledgement" ADD COLUMN "packet_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_packet_acknowledgement" DROP CONSTRAINT "supplier_packet_acknowledgement_pkey";--> statement-breakpoint
ALTER TABLE "supplier_packet_acknowledgement" ADD CONSTRAINT "supplier_packet_acknowledgement_pkey" PRIMARY KEY ("packet_id");--> statement-breakpoint
ALTER TABLE "supplier_packet_acknowledgement" ADD CONSTRAINT "supplier_packet_acknowledgement_packet_id_supplier_packet_id_fk" FOREIGN KEY ("packet_id") REFERENCES "public"."supplier_packet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
REVOKE ALL ON public.supplier_packet_acknowledgement FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON public.supplier_packet_acknowledgement TO gphkm_runtime;--> statement-breakpoint
CREATE POLICY supplier_packet_ack_staff_read ON public.supplier_packet_acknowledgement FOR SELECT TO gphkm_runtime USING (
  public.gphkm_supplier_packet_access(packet_id, nullif(current_setting('app.user_id', true), ''))
);--> statement-breakpoint
CREATE POLICY supplier_packet_ack_staff_insert ON public.supplier_packet_acknowledgement FOR INSERT TO gphkm_runtime WITH CHECK (
  recorded_by_user_id = nullif(current_setting('app.user_id', true), '')
  AND public.gphkm_supplier_packet_access(packet_id, recorded_by_user_id)
);--> statement-breakpoint
CREATE FUNCTION public.gphkm_supplier_packet_ack_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE attempt_row public.supplier_packet_attempt%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.recorded_by_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '') THEN
    RAISE EXCEPTION 'supplier acknowledgement is append-only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO attempt_row FROM public.supplier_packet_attempt
   WHERE id = NEW.attempt_id AND packet_id = NEW.packet_id FOR SHARE;
  IF NOT FOUND OR NOT (
       attempt_row.state = 'DELIVERED' AND attempt_row.delivered_at IS NOT NULL
       OR attempt_row.type = 'MANUAL_SENT' AND attempt_row.state = 'MANUAL_SENT' AND attempt_row.sent_at IS NOT NULL
     ) OR NEW.acknowledged_at < coalesce(attempt_row.delivered_at, attempt_row.sent_at)
     OR NEW.acknowledged_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'supplier acknowledgement evidence is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.gphkm_supplier_packet_ack_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER supplier_packet_ack_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.supplier_packet_acknowledgement
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_supplier_packet_ack_guard();
