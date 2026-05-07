ALTER TABLE budget_transactions
  ADD COLUMN IF NOT EXISTS discount DECIMAL(14,2) NULL AFTER quantity;
