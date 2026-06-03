SET @template_items_table = (
  SELECT CASE
    WHEN SUM(table_name = 'fm_project_costing_template_items') > 0 THEN 'fm_project_costing_template_items'
    WHEN SUM(table_name = 'fm_project_consting_template_items') > 0 THEN 'fm_project_consting_template_items'
    WHEN SUM(table_name = 'template_items') > 0 THEN 'template_items'
    ELSE NULL
  END
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name IN ('fm_project_costing_template_items', 'fm_project_consting_template_items', 'template_items')
);

SET @sql = IF(
  @template_items_table IS NULL,
  'SELECT 1',
  CONCAT(
    'ALTER TABLE `', @template_items_table, '` ',
    'ADD COLUMN catalog_material_id INT NULL AFTER section_key, ',
    'ADD KEY idx_fm_project_costing_template_items_catalog_material (catalog_material_id), ',
    'ADD CONSTRAINT fk_fm_project_costing_template_items_catalog_material ',
    'FOREIGN KEY (catalog_material_id) REFERENCES material_prices(id)'
  )
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
