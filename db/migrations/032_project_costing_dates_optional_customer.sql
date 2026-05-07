ALTER TABLE customer_projects
  MODIFY COLUMN customer_id INT NULL,
  ADD COLUMN IF NOT EXISTS start_date DATE NULL AFTER project_date,
  ADD COLUMN IF NOT EXISTS end_date DATE NULL AFTER start_date;

UPDATE customer_projects
SET start_date = project_date
WHERE start_date IS NULL
  AND project_date IS NOT NULL;
