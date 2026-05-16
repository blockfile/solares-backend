ALTER TABLE budget_bookkeeping_entries
  ADD COLUMN IF NOT EXISTS invoice_no VARCHAR(100) NULL AFTER client,
  ADD COLUMN IF NOT EXISTS mode_of_payment VARCHAR(100) NULL AFTER description,
  ADD COLUMN IF NOT EXISTS reference_no VARCHAR(100) NULL AFTER mode_of_payment;
