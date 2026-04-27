ALTER TABLE quote_items
  ADD COLUMN IF NOT EXISTS margin_rate decimal(8,4) NULL DEFAULT NULL AFTER base_price;
