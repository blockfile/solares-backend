SET @old_template_items_exists = (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'template_items'
);

SET @new_template_items_exists = (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'fm_project_costing_template_items'
);

SET @sql = IF(
  @old_template_items_exists > 0 AND @new_template_items_exists = 0,
  'RENAME TABLE `template_items` TO `fm_project_costing_template_items`',
  'SELECT 1'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
