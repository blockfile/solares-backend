SET @template_items_table = (
  SELECT CASE
    WHEN SUM(table_name = 'project_costing_template_items') > 0 THEN 'project_costing_template_items'
    WHEN SUM(table_name = 'template_items') > 0 THEN 'template_items'
    WHEN SUM(table_name = 'project_consting_template_items') > 0 THEN 'project_consting_template_items'
    WHEN SUM(table_name = 'fm_project_costing_template_items') > 0 THEN 'fm_project_costing_template_items'
    WHEN SUM(table_name = 'fm_project_consting_template_items') > 0 THEN 'fm_project_consting_template_items'
    ELSE NULL
  END
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name IN (
      'project_costing_template_items',
      'template_items',
      'project_consting_template_items',
      'fm_project_costing_template_items',
      'fm_project_consting_template_items'
    )
);

SET @sql = IF(
  @template_items_table IS NULL,
  'SELECT 1',
  CONCAT('ALTER TABLE `', @template_items_table, '` ADD COLUMN section_key VARCHAR(50) NULL AFTER base_price')
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
