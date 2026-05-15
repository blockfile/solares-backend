ALTER TABLE budget_bookkeeping_entries
  ADD COLUMN IF NOT EXISTS pr_code VARCHAR(100) NULL AFTER section,
  ADD COLUMN IF NOT EXISTS note TEXT NULL AFTER due_date;
