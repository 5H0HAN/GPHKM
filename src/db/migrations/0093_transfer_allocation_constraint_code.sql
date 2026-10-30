CREATE OR REPLACE FUNCTION public.gphkm_validate_supplier_transfer_allocation_total() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE event_id text; expected_amount numeric(20,0); allocated_amount numeric(20,0); allocation_count integer;
BEGIN
  IF TG_TABLE_NAME = 'supplier_transfer_event' THEN event_id := NEW.id;
  ELSE event_id := NEW.transfer_event_id;
  END IF;
  SELECT event.amount_minor INTO expected_amount FROM public.supplier_transfer_event event WHERE event.id = event_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT coalesce(sum(allocation.amount_minor), 0), count(*)
    INTO allocated_amount, allocation_count
    FROM public.supplier_transfer_allocation allocation WHERE allocation.transfer_event_id = event_id;
  IF allocation_count = 0 OR allocated_amount <> expected_amount THEN
    RAISE EXCEPTION 'supplier transfer allocations must exactly equal the transfer amount'
      USING ERRCODE = '23514', DETAIL = format('transfer %s expects %s minor units across at least one allocation; recorded %s across %s allocation(s)', event_id, expected_amount, allocated_amount, allocation_count);
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.gphkm_validate_supplier_transfer_allocation_total() FROM PUBLIC;
