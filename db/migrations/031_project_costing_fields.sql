ALTER TABLE customer_projects
  ADD COLUMN IF NOT EXISTS system_package VARCHAR(160) NULL AFTER project_name,
  ADD COLUMN IF NOT EXISTS location VARCHAR(255) NULL AFTER system_package,
  ADD COLUMN IF NOT EXISTS project_category VARCHAR(32) NOT NULL DEFAULT 'materials' AFTER status;

UPDATE customer_projects p
JOIN customers c ON c.id = p.customer_id
SET p.location = c.address
WHERE (p.location IS NULL OR TRIM(p.location) = '')
  AND c.address IS NOT NULL
  AND TRIM(c.address) <> '';
