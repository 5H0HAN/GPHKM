CREATE TABLE "stripe_finance_refresh" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_attempt_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stripe_finance_refresh" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stripe_finance_refresh" ADD CONSTRAINT "stripe_finance_refresh_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_finance_refresh" ADD CONSTRAINT "stripe_finance_refresh_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stripe_finance_refresh_attempt_started_idx" ON "stripe_finance_refresh" USING btree ("payment_attempt_id","started_at");
REVOKE ALL ON public.stripe_finance_refresh FROM PUBLIC, gphkm_runtime;
CREATE TRIGGER stripe_finance_refresh_immutable
  BEFORE UPDATE OR DELETE ON public.stripe_finance_refresh
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_reject_finance_reconciliation_mutation();

CREATE FUNCTION public.gphkm_start_stripe_finance_refresh(target_attempt_id text)
RETURNS TABLE(refresh_id text, started_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id text := nullif(current_setting('app.user_id', true), '');
  attempt_row public.payment_attempt%ROWTYPE;
  inserted_id text := gen_random_uuid()::text;
  start_time timestamptz := clock_timestamp();
BEGIN
  IF actor_id IS NULL OR NOT public.gphkm_is_active_staff(actor_id, 'FINANCE')
     OR target_attempt_id IS NULL OR target_attempt_id !~ '^[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'Stripe provider refresh unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO attempt_row FROM public.payment_attempt WHERE id = target_attempt_id AND provider = 'STRIPE' FOR UPDATE;
  IF NOT FOUND OR attempt_row.provider_payment_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.stripe_reconciliation_case c WHERE c.payment_attempt_id = target_attempt_id AND c.state = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'Stripe review case is unavailable' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.stripe_finance_refresh(id, payment_attempt_id, actor_user_id, started_at)
  VALUES (inserted_id, target_attempt_id, actor_id, start_time);
  RETURN QUERY SELECT inserted_id, start_time;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_start_stripe_finance_refresh(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gphkm_start_stripe_finance_refresh(text) TO gphkm_runtime;

CREATE FUNCTION public.gphkm_validate_snapshot_refresh_token() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE refresh_row public.stripe_finance_refresh%ROWTYPE;
BEGIN
  SELECT * INTO refresh_row FROM public.stripe_finance_refresh
   WHERE id = NEW.facts->>'refreshId' AND payment_attempt_id = NEW.payment_attempt_id
     AND actor_user_id = NEW.actor_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stripe snapshot refresh evidence is unavailable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gphkm_validate_snapshot_refresh_token() FROM PUBLIC;
CREATE TRIGGER stripe_finance_snapshot_require_refresh_token
  BEFORE INSERT ON public.stripe_finance_snapshot
  FOR EACH ROW EXECUTE FUNCTION public.gphkm_validate_snapshot_refresh_token();
