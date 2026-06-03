SET @misspelled_template_items_exists = (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'fm_project_consting_template_items'
);

SET @correct_template_items_exists = (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'fm_project_costing_template_items'
);

SET @sql = IF(
  @misspelled_template_items_exists > 0 AND @correct_template_items_exists = 0,
  'RENAME TABLE `fm_project_consting_template_items` TO `fm_project_costing_template_items`',
  'SELECT 1'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
