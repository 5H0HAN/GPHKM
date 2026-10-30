-- Durable replay protection for manually recorded supplier payment evidence.
ALTER TABLE supplier_payment_record ADD COLUMN idempotency_key text;
ALTER TABLE supplier_payment_record ADD COLUMN request_hash text;
UPDATE supplier_payment_record
  SET idempotency_key = 'legacy-' || id,
      request_hash = repeat('0', 64)
  WHERE idempotency_key IS NULL OR request_hash IS NULL;
ALTER TABLE supplier_payment_record ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE supplier_payment_record ALTER COLUMN request_hash SET NOT NULL;
ALTER TABLE supplier_payment_record ADD CONSTRAINT supplier_payment_idempotency_valid
  CHECK (length(idempotency_key) BETWEEN 16 AND 128 AND request_hash ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX supplier_payment_actor_idempotency_uq
  ON supplier_payment_record(actor_user_id, idempotency_key);
