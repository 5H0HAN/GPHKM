CREATE TABLE public.supplier_item_notice (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES public.support_case(id),
  order_item_id text NOT NULL REFERENCES public.customer_order_item(id),
  packet_id text NOT NULL REFERENCES public.supplier_packet(id),
  notice_type text NOT NULL CHECK (notice_type IN ('WITHDRAWAL','CORRECTION')),
  recipient text NOT NULL CHECK (length(recipient) BETWEEN 3 AND 254 AND recipient !~ '[[:cntrl:]]'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id text NOT NULL REFERENCES public.auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_item_notice_repeat_uq UNIQUE (case_id, notice_type, content_hash)
);
CREATE INDEX supplier_item_notice_case_created_idx ON public.supplier_item_notice(case_id, created_at);
ALTER TABLE public.supplier_item_notice ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.supplier_item_notice_attempt (
  id text PRIMARY KEY,
  notice_id text NOT NULL REFERENCES public.supplier_item_notice(id),
  state text NOT NULL CHECK (state IN ('SENDING','ACCEPTED','UNKNOWN','RECONCILED_FAILED','EXPORTED','MANUAL_SENT','SUPPLIER_STOP_CONFIRMED','SUPPLIER_CONTINUING','UNABLE_TO_CONFIRM')),
  actor_user_id text NOT NULL REFERENCES public.auth_user(id),
  idempotency_key text NOT NULL UNIQUE,
  provider_reference text CHECK (provider_reference IS NULL OR (length(provider_reference) BETWEEN 1 AND 200 AND provider_reference !~ '[[:cntrl:]]')),
  manual_reference text CHECK (manual_reference IS NULL OR (length(manual_reference) BETWEEN 1 AND 320 AND manual_reference !~ '[[:cntrl:]]')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_item_notice_manual_sent_shape CHECK (
    (state IN ('MANUAL_SENT','SUPPLIER_STOP_CONFIRMED','SUPPLIER_CONTINUING','UNABLE_TO_CONFIRM')
      AND ((manual_reference IS NULL AND sent_at IS NULL)
        OR (manual_reference IS NOT NULL AND sent_at IS NOT NULL)))
    OR (state NOT IN ('MANUAL_SENT','SUPPLIER_STOP_CONFIRMED','SUPPLIER_CONTINUING','UNABLE_TO_CONFIRM')
      AND manual_reference IS NULL AND sent_at IS NULL))
);
CREATE INDEX supplier_item_notice_attempt_notice_idx ON public.supplier_item_notice_attempt(notice_id, created_at);
ALTER TABLE public.supplier_item_notice_attempt ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.supplier_item_notice_event (
  id text PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES public.supplier_item_notice_attempt(id),
  actor_user_id text REFERENCES public.auth_user(id),
  actor_kind text NOT NULL CHECK ((actor_kind = 'STAFF' AND actor_user_id IS NOT NULL) OR (actor_kind = 'PROVIDER' AND actor_user_id IS NULL)),
  from_state text,
  to_state text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  reference text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_item_notice_event_history_idx ON public.supplier_item_notice_event(attempt_id, created_at);
ALTER TABLE public.supplier_item_notice_event ENABLE ROW LEVEL SECURITY;
