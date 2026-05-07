ALTER TABLE customer_projects
  ADD COLUMN IF NOT EXISTS materials_details LONGTEXT NULL AFTER end_date,
  ADD COLUMN IF NOT EXISTS labor_details LONGTEXT NULL AFTER materials_details,
  ADD COLUMN IF NOT EXISTS other_expenses_details LONGTEXT NULL AFTER labor_details;
