-- Accounting Management module
UPDATE roles
SET modules_json = JSON_ARRAY_APPEND(
  CASE
    WHEN JSON_SEARCH(modules_json, 'one', 'accounting') IS NULL
    THEN modules_json
    ELSE modules_json
  END,
  '$',
  'accounting'
)
WHERE role_key = 'admin'
  AND JSON_SEARCH(modules_json, 'one', 'accounting') IS NULL;
