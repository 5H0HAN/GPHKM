ALTER TABLE public.wallet_ledger_entry DROP CONSTRAINT wallet_ledger_kind_sign;
ALTER TABLE public.wallet_ledger_entry ADD CONSTRAINT wallet_ledger_reversal_operation
  CHECK (kind <> 'REVERSAL' OR operation = 'STRIPE_RECONCILIATION');
ALTER TABLE public.wallet_ledger_entry ADD CONSTRAINT wallet_ledger_kind_sign CHECK (
  (kind = 'ORDER_DEBIT' AND delta_minor < 0)
  OR (kind = 'REVERSAL' AND delta_minor <> 0)
  OR (kind NOT IN ('ORDER_DEBIT','REVERSAL') AND delta_minor > 0)
);
