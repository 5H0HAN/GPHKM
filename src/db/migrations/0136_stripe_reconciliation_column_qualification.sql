-- Qualify the ledger column that collides with the resolver's PL/pgSQL local
-- variable. Fail closed if the reviewed function body has drifted.
DO $migration$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.gphkm_resolve_stripe_reconciliation_case_apply(text,text,text,text)'::regprocedure
  ) INTO definition;
  IF position('sum(-delta_minor)' IN definition) = 0 THEN
    RAISE EXCEPTION 'Stripe reconciliation resolver body changed; review the variable/column qualification';
  END IF;
  definition := replace(definition, 'sum(-delta_minor)', 'sum(-public.wallet_ledger_entry.delta_minor)');
  EXECUTE definition;
END;
$migration$;
