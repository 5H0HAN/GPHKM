-- Keep malformed destinations out even if an internal caller bypasses application validation.
ALTER TABLE customer_order_item
  ADD CONSTRAINT customer_order_item_target_url_safe
  CHECK (
    target_url ~* '^https?://[^/?#[:space:]]+([/?#].*)?$'
    AND target_url !~* '^https?://[^/@?#]+@'
    AND target_url !~ '[[:cntrl:][:space:]]'
  );
